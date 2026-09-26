'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers');

test('设备锁：叫号锁定设备，占用/离线拒绝，确认后释放', async (t) => {
  const { api } = await startApp(t);

  // 两个订单排队
  const o1 = (await api('/api/orders', { method: 'POST', body: { specId: 'id-1inch', copies: 1 } })).body.order;
  const o2 = (await api('/api/orders', { method: 'POST', body: { specId: 'id-1inch', copies: 1 } })).body.order;

  // 叫号 → booth-1 锁定给 o1
  let r = await api('/api/queue/call-next', { method: 'POST', body: { deviceId: 'booth-1' } });
  assert.equal(r.status, 200);
  let dev = r.body.devices.find((d) => d.id === 'booth-1');
  assert.equal(dev.serving.id, o1.id);

  // 同一设备再次叫号 → 409 DEVICE_BUSY
  r = await api('/api/queue/call-next', { method: 'POST', body: { deviceId: 'booth-1' } });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'DEVICE_BUSY');

  // 设备离线 → 409 DEVICE_OFFLINE
  await api('/api/devices/booth-2/status', { method: 'POST', body: { status: 'offline' } });
  r = await api('/api/queue/call-next', { method: 'POST', body: { deviceId: 'booth-2' } });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'DEVICE_OFFLINE');
  await api('/api/devices/booth-2/status', { method: 'POST', body: { status: 'online' } });

  // 拍摄中设备离线 → 拍摄被拒绝
  await api('/api/devices/booth-1/status', { method: 'POST', body: { status: 'offline' } });
  r = await api(`/api/orders/${o1.id}/shoot`, { method: 'POST', body: {} });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'DEVICE_OFFLINE');
  await api('/api/devices/booth-1/status', { method: 'POST', body: { status: 'online' } });

  // o1 完成拍摄并确认 → 设备锁释放，booth-1 可服务 o2
  await api(`/api/orders/${o1.id}/shoot`, { method: 'POST', body: {} });
  await api(`/api/orders/${o1.id}/finish-shooting`, { method: 'POST' });
  const detail = (await api(`/api/orders/${o1.id}`)).body;
  await api(`/api/orders/${o1.id}/confirm`, {
    method: 'POST',
    body: { candidateId: detail.candidates[0].id, crop: { x: 165, y: 200, w: 571, h: 800 }, terminalId: 'T1' },
  });
  dev = (await api('/api/devices')).body.find((d) => d.id === 'booth-1');
  assert.equal(dev.locked_by, null);

  r = await api('/api/queue/call-next', { method: 'POST', body: { deviceId: 'booth-1' } });
  assert.equal(r.status, 200);
  dev = r.body.devices.find((d) => d.id === 'booth-1');
  assert.equal(dev.serving.id, o2.id);
});

test('设备锁：未叫号的订单不能拍摄；释放设备后订单回到队列', async (t) => {
  const { api } = await startApp(t);
  const o = (await api('/api/orders', { method: 'POST', body: { specId: 'id-1inch', copies: 1 } })).body.order;

  let r = await api(`/api/orders/${o.id}/shoot`, { method: 'POST', body: {} });
  assert.equal(r.status, 409); // 未叫号，状态非法

  await api('/api/queue/call-next', { method: 'POST', body: { deviceId: 'booth-1' } });
  r = await api(`/api/orders/${o.id}/release`, { method: 'POST', body: {} });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'WAITING');
  const dev = (await api('/api/devices')).body.find((d) => d.id === 'booth-1');
  assert.equal(dev.locked_by, null);
});
