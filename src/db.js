'use strict';
const { DatabaseSync } = require('node:sqlite');

/**
 * SQLite 持久化全部订单状态。关键并发原语：
 *  - 设备锁 / 确认候选 / 退款审批均使用「条件 UPDATE + changes 计数」实现原子抢占，
 *    先写者胜，后到者收到 409。
 */
const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS devices (
  id          TEXT PRIMARY KEY,          -- 拍摄亭设备，如 booth-1
  name        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'online',   -- online | offline
  locked_by   TEXT,                      -- 当前占用设备的订单 id
  locked_at   TEXT,
  updated_at  TEXT
);

CREATE TABLE IF NOT EXISTS specs (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,          -- 一寸 / 二寸 / 护照 ...
  width_mm       REAL NOT NULL,
  height_mm      REAL NOT NULL,
  px_width       INTEGER NOT NULL,       -- 300dpi 要求像素
  px_height      INTEGER NOT NULL,
  bg_color       TEXT NOT NULL DEFAULT '#ffffff',
  active         INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS queue_counters (
  queue_date TEXT PRIMARY KEY,
  next       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id                    TEXT PRIMARY KEY,
  queue_no              TEXT NOT NULL,
  queue_date            TEXT NOT NULL,
  spec_id               TEXT NOT NULL REFERENCES specs(id),
  copies                INTEGER NOT NULL DEFAULT 1,   -- 冲印份数
  status                TEXT NOT NULL,                -- 见下方状态机
  device_id             TEXT,
  round                 INTEGER NOT NULL DEFAULT 0,   -- 已用拍摄轮次
  max_rounds            INTEGER NOT NULL DEFAULT 3,
  selected_candidate_id TEXT,
  crop_json             TEXT,                          -- {x,y,w,h} 源图像素
  crop_file             TEXT,
  retouched_file        TEXT,
  pickup_code           TEXT,
  pickup_status         TEXT,                          -- ACTIVE | EXPIRED | USED | VOID
  pickup_expires_at     TEXT,
  payment_json          TEXT,                          -- 付款回执（修图角色不可见）
  version               INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  UNIQUE(queue_date, queue_no)
);
-- 状态机：WAITING → SHOOTING → SELECTING → RETOUCH_PENDING → PRINT_PENDING
--         → READY → PICKED_UP；任意前置环节可 → REFUNDED

CREATE TABLE IF NOT EXISTS candidates (
  id         TEXT PRIMARY KEY,
  order_id   TEXT NOT NULL REFERENCES orders(id),
  round      INTEGER NOT NULL,
  file       TEXT NOT NULL,              -- 相对 dataDir 的路径
  width_px   INTEGER NOT NULL,
  height_px  INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_candidates_order ON candidates(order_id);

CREATE TABLE IF NOT EXISTS retouch_tasks (
  id         TEXT PRIMARY KEY,
  order_id   TEXT NOT NULL REFERENCES orders(id),
  status     TEXT NOT NULL DEFAULT 'PENDING',   -- PENDING | IN_PROGRESS | DONE | CANCELLED
  assignee   TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_retouch_order ON retouch_tasks(order_id);

CREATE TABLE IF NOT EXISTS print_tasks (
  id          TEXT PRIMARY KEY,
  order_id    TEXT NOT NULL REFERENCES orders(id),
  kind        TEXT NOT NULL DEFAULT 'PRINT',    -- PRINT | REPRINT(加印)
  reprint_of  TEXT,                             -- 关联的原始冲印任务
  copies      INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'PENDING',  -- PENDING | PRINTING | SUCCESS | FAILED | CANCELLED
  fail_reason TEXT,                             -- OUT_OF_PAPER 等
  attempts    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_print_order ON print_tasks(order_id);

CREATE TABLE IF NOT EXISTS refunds (
  id           TEXT PRIMARY KEY,
  order_id     TEXT NOT NULL UNIQUE REFERENCES orders(id),  -- 一单一笔退款，幂等锚点
  reason       TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'PENDING',  -- PENDING | APPROVED | REJECTED
  refund_no    TEXT,
  requested_by TEXT,
  approved_by  TEXT,
  created_at   TEXT NOT NULL,
  decided_at   TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id   TEXT,
  actor      TEXT,
  action     TEXT NOT NULL,
  detail     TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_order ON audit_log(order_id);
`;

function openDb(dbFile) {
  const db = new DatabaseSync(dbFile);
  db.exec(SCHEMA);
  return db;
}

function audit(db, { orderId = null, actor = 'system', action, detail = null }) {
  db.prepare(
    'INSERT INTO audit_log (order_id, actor, action, detail, created_at) VALUES (?,?,?,?,?)'
  ).run(orderId, actor, action, detail ? JSON.stringify(detail) : null, new Date().toISOString());
}

module.exports = { openDb, audit };
