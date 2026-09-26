'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/app');

/** 启动隔离的测试实例（临时目录 + 随机端口），返回操作句柄 */
async function startApp(t, overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idphoto-test-'));
  const app = createApp({ dataDir, port: 0, sweepIntervalMs: 60_000, ...overrides });
  const port = await app.listen(0);
  t.after(() => { app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;

  async function api(p, { method = 'GET', body, role = 'staff' } = {}) {
    const res = await fetch(base + p, {
      method,
      headers: { 'content-type': 'application/json', 'x-role': role },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, body: data };
  }

  /** 推进订单到「选片中」：下单 → 叫号 → 拍摄 → 结束拍摄 */
  async function driveToSelecting({ deviceId = 'booth-1', copies = 2 } = {}) {
    const created = await api('/api/orders', { method: 'POST', body: { specId: 'id-1inch', copies } });
    const orderId = created.body.order.id;
    await api('/api/queue/call-next', { method: 'POST', body: { deviceId } });
    await api(`/api/orders/${orderId}/shoot`, { method: 'POST', body: {} });
    await api(`/api/orders/${orderId}/finish-shooting`, { method: 'POST' });
    const detail = await api(`/api/orders/${orderId}`);
    return { orderId, order: detail.body };
  }

  /** 推进订单到「已完成」：确认 → 修正完成（自动冲印成功） */
  async function driveToReady(opts = {}) {
    const { orderId, order } = await driveToSelecting(opts);
    const cand = order.candidates[0];
    const crop = { x: 165, y: 200, w: 571, h: 800 }; // 一寸 25×35mm 比例
    await api(`/api/orders/${orderId}/confirm`, { method: 'POST', body: { candidateId: cand.id, crop, terminalId: 'T1' } });
    const queue = await api('/api/retouch/queue', { role: 'retoucher' });
    const task = queue.body.find((x) => x.order_id === orderId);
    await api(`/api/retouch/${task.id}/complete`, { method: 'POST', role: 'retoucher' });
    const detail = await api(`/api/orders/${orderId}`);
    return { orderId, order: detail.body };
  }

  return { app, api, driveToSelecting, driveToReady, base };
}

module.exports = { startApp };
