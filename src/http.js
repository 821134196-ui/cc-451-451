'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { HttpError } = require('./util');
const svc = require('./service');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

function sendError(res, err) {
  const status = err.status || 500;
  const code = err.code || 'INTERNAL';
  if (status >= 500) console.error('[500]', err);
  sendJson(res, status, { error: { code, message: err.message || '服务器内部错误' } });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1e6) reject(new HttpError(413, 'BODY_TOO_LARGE', '请求体过大'));
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new HttpError(400, 'BAD_JSON', '请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

function compilePath(pattern) {
  const keys = [];
  const regex = new RegExp('^' + pattern.replace(/:[^/]+/g, (m) => {
    keys.push(m.slice(1));
    return '([^/]+)';
  }) + '$');
  return { regex, keys };
}

/** 角色：customer < retoucher / staff < manager，经 x-role 头传递（演示用简易鉴权） */
function needRole(req, allowed) {
  if (!allowed.includes(req.role)) {
    throw new HttpError(403, 'FORBIDDEN', `当前角色「${roleName(req.role)}」无权执行该操作`);
  }
}
function roleName(r) {
  return { customer: '顾客', staff: '店员', retoucher: '修图人员', manager: '店长' }[r] || r;
}

function serveFile(res, absPath) {
  const ext = path.extname(absPath).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  fs.readFile(absPath, (err, buf) => {
    if (err) return sendError(res, new HttpError(404, 'NOT_FOUND', '文件不存在'));
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' });
    res.end(buf);
  });
}

function createServer(ctx) {
  const { db, config } = ctx;
  const routes = [];
  const route = (method, pattern, handler) => routes.push({ method, ...compilePath(pattern), handler });

  const actor = (req) => `${roleName(req.role)}`;

  /* ------------------------------ 元数据 ------------------------------ */
  route('GET', '/api/meta', async () => ({
    specs: db.prepare('SELECT * FROM specs WHERE active = 1 ORDER BY rowid').all(),
    devices: db.prepare('SELECT * FROM devices ORDER BY id').all(),
    pricing: { baseCents: config.priceBaseCents, extraCopyCents: config.priceExtraCopyCents, maxCopies: config.maxCopies },
    printer: { paper: ctx.printer.state.paper },
    pickupTtlMs: config.pickupTtlMs,
  }));

  route('GET', '/api/health', async () => ({ ok: true, time: new Date().toISOString() }));

  /* ------------------------------ 设备 ------------------------------ */
  route('GET', '/api/devices', async () => svc.queueState(ctx).devices);

  route('POST', '/api/devices/:id/status', async (req) => {
    needRole(req, ['staff', 'manager']);
    const body = await readBody(req);
    return svc.setDeviceStatus(ctx, { deviceId: req.params.id, status: body.status, actor: actor(req) });
  });

  /* ------------------------------ 订单 ------------------------------ */
  route('POST', '/api/orders', async (req) => {
    const body = await readBody(req);
    return svc.createOrder(ctx, { specId: body.specId, copies: body.copies });
  });

  route('GET', '/api/orders', async (req) => {
    needRole(req, ['staff', 'manager', 'retoucher']);
    const rows = db.prepare('SELECT id FROM orders ORDER BY created_at DESC LIMIT 200').all();
    return rows.map((r) => svc.serializeOrder(db, svc.mustGetOrder(db, r.id), req.role));
  });

  route('GET', '/api/orders/:id', async (req) =>
    svc.serializeOrder(db, svc.mustGetOrder(db, req.params.id), req.role));

  route('POST', '/api/orders/:id/release', async (req) => {
    needRole(req, ['staff', 'manager']);
    return svc.releaseDevice(ctx, { orderId: req.params.id, actor: actor(req) });
  });

  route('POST', '/api/orders/:id/shoot', async (req) => {
    const body = await readBody(req);
    return svc.shoot(ctx, { orderId: req.params.id, simulate: body.simulate });
  });

  route('POST', '/api/orders/:id/finish-shooting', async (req) =>
    svc.finishShooting(ctx, { orderId: req.params.id }));

  route('POST', '/api/orders/:id/confirm', async (req) => {
    const body = await readBody(req);
    return svc.confirmSelection(ctx, {
      orderId: req.params.id, candidateId: body.candidateId, crop: body.crop, terminalId: body.terminalId,
    });
  });

  route('POST', '/api/orders/:id/reopen', async (req) => {
    needRole(req, ['staff', 'manager']);
    const body = await readBody(req);
    return svc.reopenSelection(ctx, { orderId: req.params.id, reason: body.reason, actor: actor(req) });
  });

  route('POST', '/api/orders/:id/reprints', async (req) => {
    needRole(req, ['staff', 'manager']);
    const body = await readBody(req);
    return svc.createReprint(ctx, { orderId: req.params.id, copies: body.copies, actor: actor(req) });
  });

  route('POST', '/api/orders/:id/pickup-reissue', async (req) => {
    needRole(req, ['staff', 'manager']);
    return svc.reissuePickup(ctx, { orderId: req.params.id, actor: actor(req) });
  });

  route('POST', '/api/orders/:id/refund-requests', async (req) => {
    needRole(req, ['staff', 'manager']);
    const body = await readBody(req);
    return svc.requestRefund(ctx, { orderId: req.params.id, reason: body.reason, actor: actor(req) });
  });

  /* ------------------------------ 叫号 ------------------------------ */
  route('GET', '/api/queue', async () => svc.queueState(ctx));

  route('POST', '/api/queue/call-next', async (req) => {
    needRole(req, ['staff', 'manager']);
    const body = await readBody(req);
    return svc.callNext(ctx, { deviceId: body.deviceId, actor: actor(req) });
  });

  /* ------------------------------ 修正 ------------------------------ */
  route('GET', '/api/retouch/queue', async (req) => {
    needRole(req, ['retoucher', 'manager', 'staff']);
    return svc.retouchQueue(ctx);
  });

  route('POST', '/api/retouch/:taskId/claim', async (req) => {
    needRole(req, ['retoucher', 'manager']);
    return svc.retouchClaim(ctx, { taskId: req.params.taskId, actor: actor(req) });
  });

  route('POST', '/api/retouch/:taskId/complete', async (req) => {
    needRole(req, ['retoucher', 'manager']);
    return svc.retouchComplete(ctx, { taskId: req.params.taskId, actor: actor(req) });
  });

  /* ------------------------------ 冲印 ------------------------------ */
  route('GET', '/api/print/tasks', async (req) => {
    needRole(req, ['staff', 'manager']);
    return svc.listPrintTasks(ctx);
  });

  route('POST', '/api/print/tasks/:taskId/retry', async (req) => {
    needRole(req, ['staff', 'manager']);
    return svc.attemptPrint(ctx, req.params.taskId);
  });

  route('GET', '/api/printer', async (req) => {
    needRole(req, ['staff', 'manager']);
    return { paper: ctx.printer.state.paper };
  });

  route('POST', '/api/printer/paper', async (req) => {
    needRole(req, ['staff', 'manager']);
    const body = await readBody(req);
    if (body.action === 'refill') ctx.printer.refill(Number(body.sheets) || 10);
    else if (body.action === 'deplete') ctx.printer.deplete();
    else throw new HttpError(422, 'ACTION_INVALID', 'action 须为 refill/deplete');
    return { paper: ctx.printer.state.paper };
  });

  /* ------------------------------ 取件 ------------------------------ */
  route('POST', '/api/pickup/verify', async (req) => {
    const body = await readBody(req);
    return svc.pickupVerify(ctx, { code: body.code });
  });

  /* ------------------------------ 退款 ------------------------------ */
  route('GET', '/api/refunds', async (req) => {
    needRole(req, ['staff', 'manager']);
    return svc.listRefunds(ctx);
  });

  route('POST', '/api/refunds/:id/approve', async (req) => {
    needRole(req, ['manager']); // 退款须店长审核
    return svc.decideRefund(ctx, { refundId: req.params.id, approve: true, actor: actor(req) });
  });

  route('POST', '/api/refunds/:id/reject', async (req) => {
    needRole(req, ['manager']);
    return svc.decideRefund(ctx, { refundId: req.params.id, approve: false, actor: actor(req) });
  });

  /* ------------------------------ 静态 ------------------------------ */
  function handleStatic(req, res, pathname) {
    if (pathname === '/') return serveFile(res, path.join(config.publicDir, 'index.html'));
    if (/^\/(css|js)\//.test(pathname)) {
      return serveFile(res, path.join(config.publicDir, pathname));
    }
    if (/^\/files\//.test(pathname)) {
      const rel = pathname.replace(/^\/files\//, '');
      const abs = path.join(config.dataDir, rel);
      if (!abs.startsWith(config.dataDir)) return sendError(res, new HttpError(403, 'FORBIDDEN', '非法路径'));
      return serveFile(res, abs);
    }
    if (/^\/[a-z-]+\.html$/.test(pathname)) {
      return serveFile(res, path.join(config.publicDir, pathname));
    }
    sendError(res, new HttpError(404, 'NOT_FOUND', '页面不存在'));
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);
    req.role = req.headers['x-role'] || 'customer';
    try {
      if (pathname.startsWith('/api/')) {
        for (const r of routes) {
          if (r.method !== req.method) continue;
          const m = r.regex.exec(pathname);
          if (!m) continue;
          req.params = Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]]));
          const result = await r.handler(req, res);
          if (!res.writableEnded) sendJson(res, 200, result === undefined ? { ok: true } : result);
          return;
        }
        throw new HttpError(404, 'NOT_FOUND', '接口不存在');
      }
      if (req.method === 'GET') return handleStatic(req, res, pathname);
      throw new HttpError(404, 'NOT_FOUND', '资源不存在');
    } catch (err) {
      if (!res.writableEnded) sendError(res, err);
    }
  });

  return server;
}

module.exports = { createServer };
