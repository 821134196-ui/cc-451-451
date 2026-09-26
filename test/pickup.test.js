'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('取件码：核验取件、重复核销拒绝、到期失效、重发恢复', async (t) => {
  // 取件码有效期 120ms，便于测试到期路径
  const { api, driveToReady, app } = await startApp(t, { pickupTtlMs: 120 });
  const { orderId, order } = await driveToReady();
  const code = order.pickup_code;
  assert.match(code, /^\d{6}$/);

  // 格式错误 → 422
  let r = await api('/api/pickup/verify', { method: 'POST', body: { code: '12' } });
  assert.equal(r.status, 422);

  // 不存在的码 → 404
  r = await api('/api/pickup/verify', { method: 'POST', body: { code: '000000' } });
  assert.equal(r.status, 404);

  // 等待过期并运行后台到期任务
  await sleep(160);
  app.tasks.sweepPickupExpiry();
  r = await api('/api/pickup/verify', { method: 'POST', body: { code } });
  assert.equal(r.status, 410);
  assert.equal(r.body.error.code, 'PICKUP_CODE_EXPIRED');

  // 店员重发取件码 → 恢复可取
  const re = await api(`/api/orders/${orderId}/pickup-reissue`, { method: 'POST', body: {} });
  assert.equal(re.status, 200);
  assert.notEqual(re.body.code, code);

  // 核验成功 → 已取件
  r = await api('/api/pickup/verify', { method: 'POST', body: { code: re.body.code } });
  assert.equal(r.status, 200);
  assert.equal(r.body.queueNo, order.queue_no);

  // 重复核销 → 409
  r = await api('/api/pickup/verify', { method: 'POST', body: { code: re.body.code } });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'ALREADY_PICKED_UP');
});
