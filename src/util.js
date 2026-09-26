'use strict';
const crypto = require('node:crypto');

function id(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
}
function nowIso() {
  return new Date().toISOString();
}
function todayKey() {
  return nowIso().slice(0, 10);
}
function fenToYuan(cents) {
  return `¥${(cents / 100).toFixed(2)}`;
}

/** 业务异常：携带 HTTP 状态码与稳定错误码，前端按 code 分支处理 */
class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

module.exports = { id, nowIso, todayKey, fenToYuan, HttpError };
