'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { id, nowIso, todayKey, HttpError } = require('./util');
const { audit } = require('./db');

/* ================================================================== *
 * 查询辅助
 * ================================================================== */

function mustGetOrder(db, orderId) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) throw new HttpError(404, 'ORDER_NOT_FOUND', '订单不存在');
  return order;
}

function getSpec(db, specId) {
  return db.prepare('SELECT * FROM specs WHERE id = ?').get(specId);
}

function listCandidates(db, orderId) {
  return db.prepare('SELECT * FROM candidates WHERE order_id = ? ORDER BY created_at, id').all(orderId);
}

/** 修图人员不可查看付款明细：序列化时按角色剥离支付字段 */
function serializeOrder(db, order, role) {
  const spec = getSpec(db, order.spec_id);
  const out = {
    ...order,
    spec,
    candidates: listCandidates(db, order.id),
    retouch_task: db.prepare('SELECT * FROM retouch_tasks WHERE order_id = ? ORDER BY created_at DESC').all(order.id),
    print_tasks: db.prepare('SELECT * FROM print_tasks WHERE order_id = ? ORDER BY created_at').all(order.id),
    refund: db.prepare('SELECT * FROM refunds WHERE order_id = ?').get(order.id) || null,
    payment: order.payment_json ? JSON.parse(order.payment_json) : null,
  };
  delete out.payment_json;
  if (role === 'retoucher') delete out.payment; // 权限：修图不可见付款
  return out;
}

/* ================================================================== *
 * 下单 / 排队 / 叫号 / 设备
 * ================================================================== */

function priceFor(config, copies) {
  return config.priceBaseCents + (copies - 1) * config.priceExtraCopyCents;
}

function nextQueueNo(db) {
  const date = todayKey();
  db.prepare(
    'INSERT INTO queue_counters (queue_date, next) VALUES (?, 1) ' +
    'ON CONFLICT(queue_date) DO UPDATE SET next = next + 1'
  ).run(date);
  const row = db.prepare('SELECT next FROM queue_counters WHERE queue_date = ?').get(date);
  return { queueDate: date, queueNo: `A${String(row.next).padStart(3, '0')}` };
}

function createOrder(ctx, { specId, copies = 1 }) {
  const { db, config, payment } = ctx;
  const spec = getSpec(db, specId);
  if (!spec || !spec.active) throw new HttpError(422, 'SPEC_UNKNOWN', '证件规格不存在或已停用');
  copies = Number(copies);
  if (!Number.isInteger(copies) || copies < 1 || copies > config.maxCopies) {
    throw new HttpError(422, 'COPIES_INVALID', `冲印份数须为 1–${config.maxCopies}`);
  }
  const orderId = id('ord');
  const { queueDate, queueNo } = nextQueueNo(db);
  const amountCents = priceFor(config, copies);
  const receipt = payment.charge({ orderId, amountCents }); // 模拟付款回执
  const now = nowIso();
  db.prepare(
    `INSERT INTO orders (id, queue_no, queue_date, spec_id, copies, status, max_rounds, payment_json, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(orderId, queueNo, queueDate, specId, copies, 'WAITING', config.maxRounds, JSON.stringify(receipt), now, now);
  audit(db, { orderId, actor: 'customer', action: 'ORDER_CREATED', detail: { queueNo, copies, amountCents } });
  return { order: serializeOrder(db, mustGetOrder(db, orderId)), receipt };
}

function queueState(ctx) {
  const { db } = ctx;
  const waiting = db.prepare(
    `SELECT o.id, o.queue_no, o.copies, o.status, o.created_at, s.name AS spec_name
     FROM orders o JOIN specs s ON s.id = o.spec_id
     WHERE o.status = 'WAITING' ORDER BY o.queue_date, o.queue_no`
  ).all();
  const devices = db.prepare('SELECT * FROM devices ORDER BY id').all().map((d) => {
    const locked = d.locked_by
      ? db.prepare('SELECT id, queue_no, status, round, max_rounds FROM orders WHERE id = ?').get(d.locked_by)
      : null;
    return { ...d, serving: locked || null };
  });
  return { waiting, devices };
}

/** 叫号：锁定拍摄设备。离线 → 409 DEVICE_OFFLINE；占用 → 409 DEVICE_BUSY */
function callNext(ctx, { deviceId, actor }) {
  const { db } = ctx;
  const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(deviceId);
  if (!device) throw new HttpError(404, 'DEVICE_NOT_FOUND', '设备不存在');
  if (device.status !== 'online') throw new HttpError(409, 'DEVICE_OFFLINE', `设备 ${device.name} 离线，无法叫号`);
  const next = db.prepare(
    `SELECT id FROM orders WHERE status = 'WAITING' ORDER BY queue_date, queue_no LIMIT 1`
  ).get();
  if (!next) throw new HttpError(404, 'QUEUE_EMPTY', '当前没有等待中的订单');
  // 原子抢锁：仅当设备空闲时占用
  const got = db.prepare(
    `UPDATE devices SET locked_by = ?, locked_at = ?, updated_at = ?
     WHERE id = ? AND status = 'online' AND locked_by IS NULL`
  ).run(next.id, nowIso(), nowIso(), deviceId);
  if (got.changes === 0) throw new HttpError(409, 'DEVICE_BUSY', `设备 ${device.name} 正在服务其他顾客`);
  db.prepare(
    `UPDATE orders SET status = 'SHOOTING', device_id = ?, version = version + 1, updated_at = ? WHERE id = ?`
  ).run(deviceId, nowIso(), next.id);
  audit(db, { orderId: next.id, actor, action: 'CALLED', detail: { deviceId } });
  return queueState(ctx);
}

function setDeviceStatus(ctx, { deviceId, status, actor }) {
  const { db } = ctx;
  if (!['online', 'offline'].includes(status)) throw new HttpError(422, 'STATUS_INVALID', '状态须为 online/offline');
  const r = db.prepare('UPDATE devices SET status = ?, updated_at = ? WHERE id = ?').run(status, nowIso(), deviceId);
  if (r.changes === 0) throw new HttpError(404, 'DEVICE_NOT_FOUND', '设备不存在');
  audit(db, { actor, action: 'DEVICE_STATUS', detail: { deviceId, status } });
  return db.prepare('SELECT * FROM devices WHERE id = ?').get(deviceId);
}

/** 释放设备：订单回到等待队列（保留已拍候选与轮次进度） */
function releaseDevice(ctx, { orderId, actor }) {
  const { db } = ctx;
  const order = mustGetOrder(db, orderId);
  if (order.status !== 'SHOOTING') throw new HttpError(409, 'INVALID_STATE', '仅拍摄中的订单可释放设备');
  db.prepare('UPDATE devices SET locked_by = NULL, locked_at = NULL, updated_at = ? WHERE locked_by = ?').run(nowIso(), orderId);
  db.prepare(`UPDATE orders SET status = 'WAITING', device_id = NULL, version = version + 1, updated_at = ? WHERE id = ?`)
    .run(nowIso(), orderId);
  audit(db, { orderId, actor, action: 'DEVICE_RELEASED' });
  return serializeOrder(db, mustGetOrder(db, orderId));
}

/* ================================================================== *
 * 拍摄：轮次 / 眨眼重拍
 * ================================================================== */

function shoot(ctx, { orderId, simulate }) {
  const { db, config, camera } = ctx;
  const order = mustGetOrder(db, orderId);
  if (order.status !== 'SHOOTING') throw new HttpError(409, 'INVALID_STATE', `当前状态 ${order.status} 不可拍摄`);
  const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(order.device_id);
  if (!device || device.status !== 'online') {
    throw new HttpError(409, 'DEVICE_OFFLINE', '拍摄设备离线，请恢复后重试');
  }
  if (device.locked_by !== orderId) throw new HttpError(409, 'DEVICE_NOT_LOCKED', '设备未锁定到本订单');
  if (order.round >= order.max_rounds) throw new HttpError(409, 'MAX_ROUNDS', '已达最大拍摄轮次，请进入选片');

  const roundNo = order.round + 1;
  let good = 0;
  let blinks = 0;
  let guard = 0;
  // 一轮连拍 shotsPerRound 张；眨眼废片自动重拍，不消耗轮次
  while (good < config.shotsPerRound && guard < config.shotsPerRound * 3) {
    guard += 1;
    const seq = db.prepare('SELECT COUNT(*) AS n FROM candidates WHERE order_id = ?').get(orderId).n + 1;
    const rel = path.posix.join('orders', orderId, `r${roundNo}-c${seq}.svg`);
    const res = camera.shoot({ destFile: path.join(config.dataDir, rel), simulate });
    if (!res.ok) {
      blinks += 1;
      audit(db, { orderId, actor: 'camera', action: 'SHOT_BLINK', detail: { round: roundNo } });
      continue;
    }
    db.prepare(
      'INSERT INTO candidates (id, order_id, round, file, width_px, height_px, created_at) VALUES (?,?,?,?,?,?,?)'
    ).run(id('cand'), orderId, roundNo, rel, res.width, res.height, nowIso());
    good += 1;
  }
  if (good === 0) {
    return { blinkOnly: true, blinks, round: order.round, maxRounds: order.max_rounds, candidates: [] };
  }
  const finished = roundNo >= order.max_rounds;
  db.prepare('UPDATE orders SET round = ?, status = ?, version = version + 1, updated_at = ? WHERE id = ?')
    .run(roundNo, finished ? 'SELECTING' : 'SHOOTING', nowIso(), orderId);
  audit(db, { orderId, actor: 'camera', action: 'ROUND_DONE', detail: { round: roundNo, shots: good, blinks } });
  return {
    blinkOnly: false,
    blinks,
    round: roundNo,
    maxRounds: order.max_rounds,
    finished,
    candidates: listCandidates(db, orderId),
  };
}

function finishShooting(ctx, { orderId }) {
  const { db } = ctx;
  const order = mustGetOrder(db, orderId);
  if (order.status === 'SELECTING') return serializeOrder(db, order);
  if (order.status !== 'SHOOTING') throw new HttpError(409, 'INVALID_STATE', '当前状态不可结束拍摄');
  if (listCandidates(db, orderId).length === 0) throw new HttpError(409, 'NO_CANDIDATES', '尚无候选照片，请先拍摄');
  db.prepare(`UPDATE orders SET status = 'SELECTING', version = version + 1, updated_at = ? WHERE id = ?`).run(nowIso(), orderId);
  audit(db, { orderId, actor: 'staff', action: 'SHOOTING_FINISHED' });
  return serializeOrder(db, mustGetOrder(db, orderId));
}

/* ================================================================== *
 * 确认候选：规格校验 + 裁切越界 + 双终端竞态
 * ================================================================== */

function validateCrop(crop, cand, spec) {
  if (!crop || !['x', 'y', 'w', 'h'].every((k) => Number.isFinite(crop[k]))) {
    throw new HttpError(422, 'CROP_INVALID', '裁切参数缺失或非法');
  }
  const { x, y, w, h } = crop;
  if (x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > cand.width_px || y + h > cand.height_px) {
    throw new HttpError(422, 'CROP_OUT_OF_BOUNDS', `裁切区域超出照片范围（照片 ${cand.width_px}×${cand.height_px}px）`);
  }
  const specAspect = spec.width_mm / spec.height_mm;
  if (Math.abs(w / h - specAspect) > 0.02) {
    throw new HttpError(422, 'SPEC_MISMATCH',
      `裁切比例 ${(w / h).toFixed(3)} 与规格「${spec.name}」${spec.width_mm}×${spec.height_mm}mm 不符`);
  }
  if (w < spec.px_width || h < spec.px_height) {
    throw new HttpError(422, 'SPEC_MISMATCH',
      `裁切像素 ${w}×${h} 低于规格要求 ${spec.px_width}×${spec.px_height}px（300dpi）`);
  }
}

/** 依据裁切框生成裁切版 SVG（占位素材直接改写 viewBox） */
function writeCropFile(config, srcRel, crop, destRel) {
  const src = fs.readFileSync(path.join(config.dataDir, srcRel), 'utf8');
  const out = src.replace(/viewBox="[^"]*"/, `viewBox="${crop.x} ${crop.y} ${crop.w} ${crop.h}"`);
  fs.mkdirSync(path.dirname(path.join(config.dataDir, destRel)), { recursive: true });
  fs.writeFileSync(path.join(config.dataDir, destRel), out);
}

function confirmSelection(ctx, { orderId, candidateId, crop, terminalId }) {
  const { db, config } = ctx;
  const order = mustGetOrder(db, orderId);
  if (order.status !== 'SELECTING') {
    if (order.selected_candidate_id) {
      throw new HttpError(409, 'ALREADY_CONFIRMED', '该订单已确认候选照片，以首次确认为准');
    }
    throw new HttpError(409, 'INVALID_STATE', `当前状态 ${order.status} 不可确认选片`);
  }
  const cand = db.prepare('SELECT * FROM candidates WHERE id = ? AND order_id = ?').get(candidateId, orderId);
  if (!cand) throw new HttpError(404, 'CANDIDATE_NOT_FOUND', '候选照片不存在');
  const spec = getSpec(db, order.spec_id);
  validateCrop(crop, cand, spec); // 规格不符 / 裁切越界 → 422

  // 原子抢占：两台终端同时确认时只接收首个版本
  const won = db.prepare(
    `UPDATE orders SET selected_candidate_id = ?, crop_json = ?, version = version + 1, updated_at = ?
     WHERE id = ? AND status = 'SELECTING' AND selected_candidate_id IS NULL`
  ).run(candidateId, JSON.stringify(crop), nowIso(), orderId);
  if (won.changes === 0) {
    throw new HttpError(409, 'ALREADY_CONFIRMED', '另一终端已先行确认，以首次确认为准');
  }

  const cropRel = path.posix.join('orders', orderId, 'crop.svg');
  writeCropFile(config, cand.file, crop, cropRel);
  db.prepare(`UPDATE orders SET crop_file = ?, status = 'RETOUCH_PENDING', updated_at = ? WHERE id = ?`)
    .run(cropRel, nowIso(), orderId);
  db.prepare('INSERT INTO retouch_tasks (id, order_id, status, created_at, updated_at) VALUES (?,?,?,?,?)')
    .run(id('rt'), orderId, 'PENDING', nowIso(), nowIso());
  db.prepare('UPDATE devices SET locked_by = NULL, locked_at = NULL, updated_at = ? WHERE locked_by = ?')
    .run(nowIso(), orderId); // 确认后释放拍摄设备
  audit(db, { orderId, actor: terminalId || 'terminal', action: 'CONFIRMED', detail: { candidateId, crop } });
  return serializeOrder(db, mustGetOrder(db, orderId));
}

/** 店员重开选择：必须填写原因；已冲印订单禁止改选原片 */
function reopenSelection(ctx, { orderId, reason, actor }) {
  const { db } = ctx;
  const order = mustGetOrder(db, orderId);
  if (!reason || !String(reason).trim()) {
    throw new HttpError(400, 'REASON_REQUIRED', '重开选择必须填写原因');
  }
  const printed = db.prepare(
    `SELECT COUNT(*) AS n FROM print_tasks WHERE order_id = ? AND kind = 'PRINT' AND status = 'SUCCESS'`
  ).get(orderId).n;
  if (printed > 0 || ['READY', 'PICKED_UP'].includes(order.status)) {
    throw new HttpError(409, 'ALREADY_PRINTED', '订单已冲印，不能改选原片；如需请创建加印任务');
  }
  if (!['SELECTING', 'RETOUCH_PENDING'].includes(order.status)) {
    throw new HttpError(409, 'INVALID_STATE', `当前状态 ${order.status} 不可重开选择`);
  }
  db.prepare(`UPDATE retouch_tasks SET status = 'CANCELLED', updated_at = ? WHERE order_id = ? AND status IN ('PENDING','IN_PROGRESS')`)
    .run(nowIso(), orderId);
  db.prepare(
    `UPDATE orders SET status = 'SELECTING', selected_candidate_id = NULL, crop_json = NULL, crop_file = NULL,
       version = version + 1, updated_at = ? WHERE id = ?`
  ).run(nowIso(), orderId);
  audit(db, { orderId, actor, action: 'REOPEN_SELECTION', detail: { reason: String(reason).trim() } });
  return serializeOrder(db, mustGetOrder(db, orderId));
}

/* ================================================================== *
 * 修正 / 冲印 / 加印
 * ================================================================== */

function retouchQueue(ctx) {
  const { db } = ctx;
  // 注意：不联出任何付款字段（修图人员不可见付款明细）
  return db.prepare(
    `SELECT t.id, t.status, t.assignee, t.created_at, t.updated_at,
            o.id AS order_id, o.queue_no, o.copies, o.crop_file, o.status AS order_status,
            s.name AS spec_name, s.width_mm, s.height_mm
     FROM retouch_tasks t
     JOIN orders o ON o.id = t.order_id
     JOIN specs s ON s.id = o.spec_id
     WHERE t.status IN ('PENDING','IN_PROGRESS')
     ORDER BY t.created_at`
  ).all();
}

function retouchClaim(ctx, { taskId, actor }) {
  const { db } = ctx;
  const r = db.prepare(
    `UPDATE retouch_tasks SET status = 'IN_PROGRESS', assignee = ?, updated_at = ? WHERE id = ? AND status = 'PENDING'`
  ).run(actor, nowIso(), taskId);
  if (r.changes === 0) throw new HttpError(409, 'INVALID_STATE', '任务不存在或已被认领');
  audit(db, { actor, action: 'RETOUCH_CLAIM', detail: { taskId } });
  return db.prepare('SELECT * FROM retouch_tasks WHERE id = ?').get(taskId);
}

/** 冲印尝试：缺纸 → FAILED(OUT_OF_PAPER)，由后台任务/人工重试 */
function attemptPrint(ctx, taskId) {
  const { db, config, printer } = ctx;
  const task = db.prepare('SELECT * FROM print_tasks WHERE id = ?').get(taskId);
  if (!task) throw new HttpError(404, 'TASK_NOT_FOUND', '冲印任务不存在');
  if (task.status === 'SUCCESS' || task.status === 'CANCELLED') return task;
  const order = mustGetOrder(db, task.order_id);
  const srcRel = order.retouched_file || order.crop_file;
  const srcFile = path.join(config.dataDir, srcRel);
  db.prepare(`UPDATE print_tasks SET status = 'PRINTING', attempts = attempts + 1, updated_at = ? WHERE id = ?`)
    .run(nowIso(), taskId);
  const res = printer.print({ srcFile, copies: task.copies, taskId });
  if (res.ok) {
    db.prepare(`UPDATE print_tasks SET status = 'SUCCESS', fail_reason = NULL, updated_at = ? WHERE id = ?`)
      .run(nowIso(), taskId);
    if (task.kind === 'PRINT') {
      issuePickupCode(ctx, order.id);
      db.prepare(`UPDATE orders SET status = 'READY', version = version + 1, updated_at = ? WHERE id = ?`)
        .run(nowIso(), order.id);
    }
    audit(db, { orderId: order.id, actor: 'printer', action: 'PRINT_SUCCESS', detail: { taskId, kind: task.kind, copies: task.copies } });
  } else {
    db.prepare(`UPDATE print_tasks SET status = 'FAILED', fail_reason = ?, updated_at = ? WHERE id = ?`)
      .run(res.reason, nowIso(), taskId);
    audit(db, { orderId: order.id, actor: 'printer', action: 'PRINT_FAILED', detail: { taskId, reason: res.reason } });
  }
  return db.prepare('SELECT * FROM print_tasks WHERE id = ?').get(taskId);
}

function issuePickupCode(ctx, orderId) {
  const { db, config } = ctx;
  let code;
  do {
    code = String(Math.floor(100000 + Math.random() * 900000));
  } while (db.prepare(`SELECT 1 AS x FROM orders WHERE pickup_code = ? AND pickup_status = 'ACTIVE'`).get(code));
  const expires = new Date(Date.now() + config.pickupTtlMs).toISOString();
  db.prepare(`UPDATE orders SET pickup_code = ?, pickup_status = 'ACTIVE', pickup_expires_at = ?, updated_at = ? WHERE id = ?`)
    .run(code, expires, nowIso(), orderId);
  audit(db, { orderId, actor: 'system', action: 'PICKUP_CODE_ISSUED', detail: { expires } });
  return code;
}

function retouchComplete(ctx, { taskId, actor }) {
  const { db, config } = ctx;
  const task = db.prepare('SELECT * FROM retouch_tasks WHERE id = ?').get(taskId);
  if (!task) throw new HttpError(404, 'TASK_NOT_FOUND', '修正任务不存在');
  if (task.status === 'DONE') throw new HttpError(409, 'ALREADY_DONE', '任务已完成');
  if (task.status === 'CANCELLED') throw new HttpError(409, 'INVALID_STATE', '任务已取消');
  const order = mustGetOrder(db, task.order_id);
  if (order.status !== 'RETOUCH_PENDING') throw new HttpError(409, 'INVALID_STATE', '订单不在待修正状态');
  // 生成精修版（占位实现：裁切版 + 元数据标记）
  const retouchedRel = path.posix.join('orders', order.id, 'retouched.svg');
  const src = fs.readFileSync(path.join(config.dataDir, order.crop_file), 'utf8');
  fs.writeFileSync(
    path.join(config.dataDir, retouchedRel),
    src.replace('<svg ', `<svg data-retouched-by="${actor}" data-retouched-at="${nowIso()}" `)
  );
  db.prepare(`UPDATE retouch_tasks SET status = 'DONE', updated_at = ? WHERE id = ?`).run(nowIso(), taskId);
  db.prepare(`UPDATE orders SET retouched_file = ?, status = 'PRINT_PENDING', version = version + 1, updated_at = ? WHERE id = ?`)
    .run(retouchedRel, nowIso(), order.id);
  const printTaskId = id('pt');
  db.prepare(
    `INSERT INTO print_tasks (id, order_id, kind, copies, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`
  ).run(printTaskId, order.id, 'PRINT', order.copies, 'PENDING', nowIso(), nowIso());
  audit(db, { orderId: order.id, actor, action: 'RETOUCH_DONE', detail: { taskId } });
  const printTask = attemptPrint(ctx, printTaskId); // 立即尝试冲印；缺纸则转后台重试
  return { retouchTask: db.prepare('SELECT * FROM retouch_tasks WHERE id = ?').get(taskId), printTask };
}

function listPrintTasks(ctx) {
  const { db } = ctx;
  return db.prepare(
    `SELECT t.*, o.queue_no, o.status AS order_status, s.name AS spec_name
     FROM print_tasks t JOIN orders o ON o.id = t.order_id JOIN specs s ON s.id = o.spec_id
     ORDER BY t.created_at DESC LIMIT 100`
  ).all();
}

/** 加印：仅已冲印订单可创建；关联原始冲印任务，不改变订单状态与取件码 */
function createReprint(ctx, { orderId, copies = 1, actor }) {
  const { db, config } = ctx;
  const order = mustGetOrder(db, orderId);
  const original = db.prepare(
    `SELECT * FROM print_tasks WHERE order_id = ? AND kind = 'PRINT' AND status = 'SUCCESS' ORDER BY created_at DESC LIMIT 1`
  ).get(orderId);
  if (!original) throw new HttpError(409, 'NOT_PRINTED', '订单尚未冲印，不能创建加印任务');
  copies = Number(copies);
  if (!Number.isInteger(copies) || copies < 1 || copies > config.maxCopies) {
    throw new HttpError(422, 'COPIES_INVALID', `加印份数须为 1–${config.maxCopies}`);
  }
  const taskId = id('pt');
  db.prepare(
    `INSERT INTO print_tasks (id, order_id, kind, reprint_of, copies, status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(taskId, orderId, 'REPRINT', original.id, copies, 'PENDING', nowIso(), nowIso());
  audit(db, { orderId, actor, action: 'REPRINT_CREATED', detail: { taskId, reprintOf: original.id, copies } });
  return attemptPrint(ctx, taskId);
}

/* ================================================================== *
 * 取件
 * ================================================================== */

function pickupVerify(ctx, { code }) {
  const { db } = ctx;
  if (!code || !/^\d{6}$/.test(String(code))) throw new HttpError(422, 'CODE_INVALID', '请输入 6 位数字取件码');
  const order = db.prepare('SELECT * FROM orders WHERE pickup_code = ?').get(String(code));
  if (!order) throw new HttpError(404, 'PICKUP_CODE_INVALID', '取件码不存在或已失效');
  if (order.pickup_status === 'USED' || order.status === 'PICKED_UP') {
    throw new HttpError(409, 'ALREADY_PICKED_UP', '该取件码已核销，订单已取件');
  }
  if (order.pickup_status === 'VOID') throw new HttpError(410, 'PICKUP_CODE_INVALID', '取件码已作废');
  if (order.pickup_status === 'EXPIRED' || Date.parse(order.pickup_expires_at) < Date.now()) {
    if (order.pickup_status !== 'EXPIRED') {
      db.prepare(`UPDATE orders SET pickup_status = 'EXPIRED', updated_at = ? WHERE id = ?`).run(nowIso(), order.id);
    }
    throw new HttpError(410, 'PICKUP_CODE_EXPIRED', '取件码已失效，请联系店员重新获取');
  }
  db.prepare(
    `UPDATE orders SET status = 'PICKED_UP', pickup_status = 'USED', version = version + 1, updated_at = ? WHERE id = ?`
  ).run(nowIso(), order.id);
  audit(db, { orderId: order.id, actor: 'pickup-terminal', action: 'PICKED_UP', detail: { code } });
  const spec = getSpec(db, order.spec_id);
  return { queueNo: order.queue_no, specName: spec.name, copies: order.copies, pickedUpAt: nowIso() };
}

function reissuePickup(ctx, { orderId, actor }) {
  const { db } = ctx;
  const order = mustGetOrder(db, orderId);
  if (order.status !== 'READY') throw new HttpError(409, 'INVALID_STATE', '仅已完成待取件的订单可重发取件码');
  const code = issuePickupCode(ctx, orderId);
  audit(db, { orderId, actor, action: 'PICKUP_CODE_REISSUED' });
  return { code, expiresAt: mustGetOrder(db, orderId).pickup_expires_at };
}

/* ================================================================== *
 * 退款：店员发起 → 店长复核；审批幂等
 * ================================================================== */

function requestRefund(ctx, { orderId, reason, actor }) {
  const { db } = ctx;
  const order = mustGetOrder(db, orderId);
  if (!reason || !String(reason).trim()) throw new HttpError(400, 'REASON_REQUIRED', '退款原因必填（如：误操作）');
  if (order.status === 'REFUNDED') throw new HttpError(409, 'ALREADY_REFUNDED', '订单已退款');
  const existing = db.prepare('SELECT * FROM refunds WHERE order_id = ?').get(orderId);
  if (existing) return existing; // 重复发起返回原申请，天然幂等
  const refundId = id('rf');
  db.prepare('INSERT INTO refunds (id, order_id, reason, status, requested_by, created_at) VALUES (?,?,?,?,?,?)')
    .run(refundId, orderId, String(reason).trim(), 'PENDING', actor, nowIso());
  audit(db, { orderId, actor, action: 'REFUND_REQUESTED', detail: { reason } });
  return db.prepare('SELECT * FROM refunds WHERE id = ?').get(refundId);
}

function listRefunds(ctx) {
  const { db } = ctx;
  return db.prepare(
    `SELECT r.*, o.queue_no, o.status AS order_status, s.name AS spec_name
     FROM refunds r JOIN orders o ON o.id = r.order_id JOIN specs s ON s.id = o.spec_id
     ORDER BY r.created_at DESC`
  ).all();
}

/**
 * 店长复核。幂等保证：
 *  1. 条件 UPDATE 仅 PENDING → 目标态，并发/重复调用只有首个生效；
 *  2. 仅状态翻转的胜者调用付款适配器退款，重复审批直接返回原结果。
 */
function decideRefund(ctx, { refundId, approve, actor }) {
  const { db, payment } = ctx;
  const rf = db.prepare('SELECT * FROM refunds WHERE id = ?').get(refundId);
  if (!rf) throw new HttpError(404, 'REFUND_NOT_FOUND', '退款申请不存在');
  if (rf.status === 'APPROVED') {
    if (approve) return { refund: rf, idempotent: true };
    throw new HttpError(409, 'REFUND_ALREADY_DECIDED', '该申请已批准退款，不可再驳回');
  }
  if (rf.status === 'REJECTED') throw new HttpError(409, 'REFUND_ALREADY_DECIDED', '该申请已被驳回');

  const target = approve ? 'APPROVED' : 'REJECTED';
  const won = db.prepare(
    `UPDATE refunds SET status = ?, approved_by = ?, decided_at = ? WHERE id = ? AND status = 'PENDING'`
  ).run(target, actor, nowIso(), refundId);
  if (won.changes === 0) { // 并发下未抢到 → 返回现状
    return { refund: db.prepare('SELECT * FROM refunds WHERE id = ?').get(refundId), idempotent: true };
  }
  if (!approve) {
    audit(db, { orderId: rf.order_id, actor, action: 'REFUND_REJECTED' });
    return { refund: db.prepare('SELECT * FROM refunds WHERE id = ?').get(refundId) };
  }
  const order = mustGetOrder(db, rf.order_id);
  const receipt = order.payment_json ? JSON.parse(order.payment_json) : null;
  const record = payment.refund({ receiptNo: receipt ? receipt.receiptNo : null, amountCents: receipt ? receipt.amountCents : 0 });
  db.prepare('UPDATE refunds SET refund_no = ? WHERE id = ?').run(record.refundNo, refundId);
  db.prepare(
    `UPDATE orders SET status = 'REFUNDED', device_id = NULL, pickup_code = NULL, pickup_status = 'VOID',
       version = version + 1, updated_at = ? WHERE id = ?`
  ).run(nowIso(), order.id);
  db.prepare('UPDATE devices SET locked_by = NULL, locked_at = NULL, updated_at = ? WHERE locked_by = ?').run(nowIso(), order.id);
  db.prepare(`UPDATE retouch_tasks SET status = 'CANCELLED', updated_at = ? WHERE order_id = ? AND status IN ('PENDING','IN_PROGRESS')`)
    .run(nowIso(), order.id);
  db.prepare(`UPDATE print_tasks SET status = 'CANCELLED', updated_at = ? WHERE order_id = ? AND status IN ('PENDING','PRINTING','FAILED')`)
    .run(nowIso(), order.id);
  audit(db, { orderId: order.id, actor, action: 'REFUND_APPROVED', detail: { refundNo: record.refundNo } });
  return { refund: db.prepare('SELECT * FROM refunds WHERE id = ?').get(refundId) };
}

module.exports = {
  serializeOrder, mustGetOrder, priceFor,
  createOrder, queueState, callNext, setDeviceStatus, releaseDevice,
  shoot, finishShooting, confirmSelection, reopenSelection,
  retouchQueue, retouchClaim, retouchComplete,
  attemptPrint, listPrintTasks, createReprint,
  pickupVerify, reissuePickup,
  requestRefund, listRefunds, decideRefund,
};
