'use strict';
const { nowIso } = require('./util');
const { audit } = require('./db');
const { attemptPrint } = require('./service');

/**
 * 进程内后台任务（无外部依赖的定时器）：
 *  1. 取件码到期：ACTIVE 且已过期的取件码标记为 EXPIRED；
 *  2. 打印重试：FAILED（如缺纸）且未超次数上限的任务自动重试。
 */
function createTasks(ctx) {
  const { db, config } = ctx;

  function sweepPickupExpiry() {
    const expired = db.prepare(
      `SELECT id FROM orders WHERE pickup_status = 'ACTIVE' AND pickup_expires_at < ?`
    ).all(nowIso());
    for (const row of expired) {
      db.prepare(`UPDATE orders SET pickup_status = 'EXPIRED', updated_at = ? WHERE id = ? AND pickup_status = 'ACTIVE'`)
        .run(nowIso(), row.id);
      audit(db, { orderId: row.id, actor: 'system', action: 'PICKUP_CODE_EXPIRED' });
    }
    return expired.length;
  }

  function sweepPrintRetry() {
    const tasks = db.prepare(
      `SELECT id FROM print_tasks WHERE status = 'FAILED' AND attempts < ?`
    ).all(config.printMaxAttempts);
    let retried = 0;
    for (const t of tasks) {
      attemptPrint(ctx, t.id);
      retried += 1;
    }
    return retried;
  }

  let timer = null;
  return {
    sweepPickupExpiry,
    sweepPrintRetry,
    start() {
      if (timer) return;
      timer = setInterval(() => {
        try { sweepPickupExpiry(); sweepPrintRetry(); } catch (e) { console.error('[sweep]', e); }
      }, config.sweepIntervalMs);
      if (timer.unref) timer.unref();
    },
    stop() { if (timer) clearInterval(timer); timer = null; },
  };
}

module.exports = { createTasks };
