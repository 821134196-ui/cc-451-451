'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers');

test('退款幂等：重复批准与并发批准只执行一次退款', async (t) => {
  const { api, driveToReady, app } = await startApp(t);
  const { orderId } = await driveToReady();

  // 店员发起（重复发起返回同一申请）
  const r1 = await api(`/api/orders/${orderId}/refund-requests`, { method: 'POST', body: { reason: '误操作' } });
  const r2 = await api(`/api/orders/${orderId}/refund-requests`, { method: 'POST', body: { reason: '误操作' } });
  assert.equal(r1.body.id, r2.body.id);
  const refundId = r1.body.id;

  // 店员无权批准 → 403
  let r = await api(`/api/refunds/${refundId}/approve`, { method: 'POST', role: 'staff' });
  assert.equal(r.status, 403);

  // 店长批准 → APPROVED + 退款单号
  r = await api(`/api/refunds/${refundId}/approve`, { method: 'POST', role: 'manager' });
  assert.equal(r.status, 200);
  assert.equal(r.body.refund.status, 'APPROVED');
  const refundNo = r.body.refund.refund_no;
  assert.ok(refundNo);

  // 顺序重复批准 → 同一退款单号，幂等返回
  r = await api(`/api/refunds/${refundId}/approve`, { method: 'POST', role: 'manager' });
  assert.equal(r.status, 200);
  assert.equal(r.body.refund.refund_no, refundNo);
  assert.equal(r.body.idempotent, true);

  // 已批准后驳回 → 409
  r = await api(`/api/refunds/${refundId}/reject`, { method: 'POST', role: 'manager' });
  assert.equal(r.status, 409);

  // 付款适配器只执行了一次退款
  assert.equal(app.ctx.payment.stats.refunds, 1);

  // 订单终态：已退款，取件码作废
  const order = (await api(`/api/orders/${orderId}`)).body;
  assert.equal(order.status, 'REFUNDED');
  assert.equal(order.pickup_code, null);
  assert.equal(order.pickup_status, 'VOID');
});

test('退款幂等：并发批准全部返回同一退款单号', async (t) => {
  const { api, driveToReady, app } = await startApp(t);
  const { orderId } = await driveToReady();
  const rf = await api(`/api/orders/${orderId}/refund-requests`, { method: 'POST', body: { reason: '误操作' } });
  const refundId = rf.body.id;

  const results = await Promise.all(
    Array.from({ length: 5 }, () => api(`/api/refunds/${refundId}/approve`, { method: 'POST', role: 'manager' }))
  );
  const nos = new Set(results.map((r) => r.body.refund.refund_no));
  assert.equal(nos.size, 1);                       // 全部同一退款单号
  assert.ok(results.every((r) => r.status === 200));
  assert.equal(app.ctx.payment.stats.refunds, 1);  // 适配器仅被调用一次
});

test('权限：修图人员不可查看付款明细', async (t) => {
  const { api, driveToReady } = await startApp(t);
  const { orderId } = await driveToReady();

  // 店员可见付款回执
  let order = (await api(`/api/orders/${orderId}`, { role: 'staff' })).body;
  assert.ok(order.payment && order.payment.receiptNo);

  // 修图人员不可见
  order = (await api(`/api/orders/${orderId}`, { role: 'retoucher' })).body;
  assert.equal(order.payment, undefined);

  // 修正队列也不携带付款字段
  const queue = (await api('/api/retouch/queue', { role: 'retoucher' })).body;
  for (const row of queue) {
    assert.ok(!('payment' in row) && !('payment_json' in row));
  }
});
