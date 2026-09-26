'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers');

const CROP = { x: 165, y: 200, w: 571, h: 800 };

test('确认竞态：两台终端同时确认，只接收首个版本', async (t) => {
  const { api, driveToSelecting } = await startApp(t);
  const { orderId, order } = await driveToSelecting();
  const [c1, c2] = order.candidates;

  // 两台终端并发确认不同候选
  const [r1, r2] = await Promise.all([
    api(`/api/orders/${orderId}/confirm`, { method: 'POST', body: { candidateId: c1.id, crop: CROP, terminalId: 'T-A' } }),
    api(`/api/orders/${orderId}/confirm`, { method: 'POST', body: { candidateId: c2.id, crop: CROP, terminalId: 'T-B' } }),
  ]);
  const statuses = [r1.status, r2.status].sort();
  assert.deepEqual(statuses, [200, 409]);

  const loser = r1.status === 409 ? r1 : r2;
  assert.equal(loser.body.error.code, 'ALREADY_CONFIRMED');

  // 落库结果与胜者一致
  const final = (await api(`/api/orders/${orderId}`)).body;
  const winnerCandidate = r1.status === 200 ? c1.id : c2.id;
  assert.equal(final.selected_candidate_id, winnerCandidate);
  assert.equal(final.status, 'RETOUCH_PENDING');

  // 再次确认仍被拒绝（幂等拒绝）
  const again = await api(`/api/orders/${orderId}/confirm`, {
    method: 'POST', body: { candidateId: c2.id, crop: CROP, terminalId: 'T-C' },
  });
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'ALREADY_CONFIRMED');
});

test('重开选择：店员必须填写原因；重开后可重新确认', async (t) => {
  const { api, driveToSelecting } = await startApp(t);
  const { orderId, order } = await driveToSelecting();
  const cand = order.candidates[0];
  await api(`/api/orders/${orderId}/confirm`, { method: 'POST', body: { candidateId: cand.id, crop: CROP, terminalId: 'T1' } });

  // 缺原因 → 400
  let r = await api(`/api/orders/${orderId}/reopen`, { method: 'POST', body: { reason: '  ' } });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'REASON_REQUIRED');

  // 顾客角色无权重开 → 403
  r = await api(`/api/orders/${orderId}/reopen`, { method: 'POST', body: { reason: '顾客反悔' }, role: 'customer' });
  assert.equal(r.status, 403);

  // 店员带原因重开 → 回到选片
  r = await api(`/api/orders/${orderId}/reopen`, { method: 'POST', body: { reason: '顾客对表情不满意' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'SELECTING');
  assert.equal(r.body.selected_candidate_id, null);

  // 可重新确认另一张
  const cand2 = order.candidates[1];
  r = await api(`/api/orders/${orderId}/confirm`, { method: 'POST', body: { candidateId: cand2.id, crop: CROP, terminalId: 'T1' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.selected_candidate_id, cand2.id);
});
