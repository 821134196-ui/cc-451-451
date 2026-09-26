'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startApp } = require('./helpers');

test('规格校验：裁切越界 / 比例不符 / 像素不足 / 合法通过', async (t) => {
  const { api, driveToSelecting, app } = await startApp(t);
  const { orderId, order } = await driveToSelecting();
  const cand = order.candidates[0]; // 900×1200
  const confirm = (crop) =>
    api(`/api/orders/${orderId}/confirm`, { method: 'POST', body: { candidateId: cand.id, crop, terminalId: 'T1' } });

  // 裁切越界：x+w 超出照片宽度
  let r = await confirm({ x: 500, y: 0, w: 571, h: 800 });
  assert.equal(r.status, 422);
  assert.equal(r.body.error.code, 'CROP_OUT_OF_BOUNDS');

  // 裁切越界：负坐标
  r = await confirm({ x: -10, y: 0, w: 571, h: 800 });
  assert.equal(r.status, 422);
  assert.equal(r.body.error.code, 'CROP_OUT_OF_BOUNDS');

  // 规格不符：比例错误（900×900 对一寸 25:35）
  r = await confirm({ x: 0, y: 0, w: 900, h: 900 });
  assert.equal(r.status, 422);
  assert.equal(r.body.error.code, 'SPEC_MISMATCH');

  // 规格不符：比例正确但像素不足（100×140 < 295×413）
  r = await confirm({ x: 0, y: 0, w: 100, h: 140 });
  assert.equal(r.status, 422);
  assert.equal(r.body.error.code, 'SPEC_MISMATCH');

  // 参数缺失
  r = await confirm({ x: 0, y: 0 });
  assert.equal(r.status, 422);
  assert.equal(r.body.error.code, 'CROP_INVALID');

  // 合法裁切 → 200，生成裁切文件，进入待修正
  r = await confirm({ x: 165, y: 200, w: 571, h: 800 });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'RETOUCH_PENDING');
  const cropAbs = path.join(app.config.dataDir, r.body.crop_file);
  assert.ok(fs.existsSync(cropAbs));
  const svg = fs.readFileSync(cropAbs, 'utf8');
  assert.match(svg, /viewBox="165 200 571 800"/);
});

test('规格校验：低像素照片无法满足一寸规格（规格不符处理路径）', async (t) => {
  const { api } = await startApp(t);
  const created = await api('/api/orders', { method: 'POST', body: { specId: 'id-1inch', copies: 1 } });
  const orderId = created.body.order.id;
  await api('/api/queue/call-next', { method: 'POST', body: { deviceId: 'booth-1' } });
  // 模拟相机产出 260×360 低像素片
  await api(`/api/orders/${orderId}/shoot`, { method: 'POST', body: { simulate: 'small' } });
  await api(`/api/orders/${orderId}/finish-shooting`, { method: 'POST' });
  const order = (await api(`/api/orders/${orderId}`)).body;
  const cand = order.candidates[0];
  assert.equal(cand.width_px, 260);

  // 即便满幅裁切（257×360，比例 0.714 正确），像素仍低于 295×413 的要求 → SPEC_MISMATCH
  const r = await api(`/api/orders/${orderId}/confirm`, {
    method: 'POST',
    body: { candidateId: cand.id, crop: { x: 0, y: 0, w: 257, h: 360 }, terminalId: 'T1' },
  });
  assert.equal(r.status, 422);
  assert.equal(r.body.error.code, 'SPEC_MISMATCH');
});

test('眨眼重拍：废片自动重拍且不消耗轮次', async (t) => {
  const { api } = await startApp(t);
  const created = await api('/api/orders', { method: 'POST', body: { specId: 'id-1inch', copies: 1 } });
  const orderId = created.body.order.id;
  await api('/api/queue/call-next', { method: 'POST', body: { deviceId: 'booth-1' } });

  // 全部眨眼 → 轮次不前进
  let r = await api(`/api/orders/${orderId}/shoot`, { method: 'POST', body: { simulate: 'blink' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.blinkOnly, true);
  assert.equal(r.body.round, 0);

  // 正常拍摄 → 进入第 1 轮
  r = await api(`/api/orders/${orderId}/shoot`, { method: 'POST', body: {} });
  assert.equal(r.body.round, 1);
  assert.equal(r.body.candidates.length, 3);
});
