'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers');

test('加印关联：已冲印订单只能加印，加印任务关联原始任务', async (t) => {
  const { api, driveToReady } = await startApp(t);
  const { orderId, order } = await driveToReady();
  assert.equal(order.status, 'READY');
  const originalTask = order.print_tasks.find((x) => x.kind === 'PRINT');
  assert.equal(originalTask.status, 'SUCCESS');

  // 已冲印 → 禁止重开选择（改选原片）
  let r = await api(`/api/orders/${orderId}/reopen`, { method: 'POST', body: { reason: '想换一张' } });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'ALREADY_PRINTED');

  // 创建加印任务 → 关联原始冲印任务
  r = await api(`/api/orders/${orderId}/reprints`, { method: 'POST', body: { copies: 3 } });
  assert.equal(r.status, 200);
  assert.equal(r.body.kind, 'REPRINT');
  assert.equal(r.body.reprint_of, originalTask.id);
  assert.equal(r.body.copies, 3);
  assert.equal(r.body.status, 'SUCCESS');

  // 加印不改变订单状态与取件码
  const after = (await api(`/api/orders/${orderId}`)).body;
  assert.equal(after.status, 'READY');
  assert.equal(after.pickup_code, order.pickup_code);
  assert.equal(after.print_tasks.filter((x) => x.kind === 'REPRINT').length, 1);
});

test('加印关联：未冲印订单不能加印', async (t) => {
  const { api, driveToSelecting } = await startApp(t);
  const { orderId } = await driveToSelecting();
  const r = await api(`/api/orders/${orderId}/reprints`, { method: 'POST', body: { copies: 1 } });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'NOT_PRINTED');
});

test('打印缺纸：任务失败标记，加纸后重试成功', async (t) => {
  const { api, driveToSelecting, app } = await startApp(t);
  // 耗尽纸张
  await api('/api/printer/paper', { method: 'POST', body: { action: 'deplete' } });

  const { orderId, order } = await driveToSelecting();
  const cand = order.candidates[0];
  await api(`/api/orders/${orderId}/confirm`, {
    method: 'POST', body: { candidateId: cand.id, crop: { x: 165, y: 200, w: 571, h: 800 }, terminalId: 'T1' },
  });
  const queue = await api('/api/retouch/queue', { role: 'retoucher' });
  const rtask = queue.body.find((x) => x.order_id === orderId);
  const done = await api(`/api/retouch/${rtask.id}/complete`, { method: 'POST', role: 'retoucher' });
  assert.equal(done.body.printTask.status, 'FAILED');
  assert.equal(done.body.printTask.fail_reason, 'OUT_OF_PAPER');

  // 订单停留在待冲印
  let detail = (await api(`/api/orders/${orderId}`)).body;
  assert.equal(detail.status, 'PRINT_PENDING');

  // 后台重试（仍缺纸）→ 仍失败
  app.tasks.sweepPrintRetry();
  detail = (await api(`/api/orders/${orderId}`)).body;
  assert.equal(detail.print_tasks[0].status, 'FAILED');

  // 加纸后后台重试 → 成功，订单 READY 并签发取件码
  await api('/api/printer/paper', { method: 'POST', body: { action: 'refill', sheets: 10 } });
  app.tasks.sweepPrintRetry();
  detail = (await api(`/api/orders/${orderId}`)).body;
  assert.equal(detail.print_tasks[0].status, 'SUCCESS');
  assert.equal(detail.status, 'READY');
  assert.match(detail.pickup_code, /^\d{6}$/);
});
