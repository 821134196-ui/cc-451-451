"""SQLite 访问层：建表、连接管理、初始化种子数据。

状态机：
  queued(已叫号/拍摄中) -> selected(顾客已选片确认) -> retouching(待修正)
  -> printing(待冲印/冲印中) -> completed(已完成) -> picked(已取件)
  另有取消分支：cancelled(已退款取消)
"""
import sqlite3
import threading
from datetime import datetime, timedelta

from . import config


SCHEMA = """
CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'camera',      -- camera / printer
    status TEXT NOT NULL DEFAULT 'online',    -- online / offline / busy / out_of_paper
    paper INTEGER NOT NULL DEFAULT 100,       -- 打印设备剩余纸张
    locked_by TEXT                            -- 当前被哪个排队号锁定
);

CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    queue_no TEXT NOT NULL UNIQUE,
    customer_name TEXT NOT NULL,
    spec_key TEXT NOT NULL,
    rounds_used INTEGER NOT NULL DEFAULT 0,   -- 已拍摄轮次
    max_rounds INTEGER NOT NULL DEFAULT 3,
    selected_photo_id INTEGER,                -- 顾客确认的原片
    confirmed_version INTEGER NOT NULL DEFAULT 0,  -- 确认版本（防并发重复确认）
    retouch_required INTEGER NOT NULL DEFAULT 0,
    retouched_photo_id INTEGER,
    status TEXT NOT NULL DEFAULT 'queued',    -- 见模块文档
    device_id TEXT,
    copies INTEGER NOT NULL DEFAULT 1,    -- 冲印份数
    amount INTEGER NOT NULL DEFAULT 0,        -- 订单金额（分）
    paid INTEGER NOT NULL DEFAULT 0,
    payment_receipt TEXT,                     -- 付款通道回执号
    pickup_code_hash TEXT,
    pickup_active INTEGER NOT NULL DEFAULT 0, -- 取件码是否有效
    pickup_deadline TEXT,
    picked_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    selection_reopened_by TEXT,               -- 店员重开选择操作人
    reopen_reason TEXT                        -- 店员重开选择的原因
);

CREATE TABLE IF NOT EXISTS photos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL,
    round INTEGER NOT NULL,
    kind TEXT NOT NULL DEFAULT 'raw',         -- raw / cropped / retouched
    src_file TEXT NOT NULL,                   -- 占位素材相对 PLACEHOLDER_DIR
    out_file TEXT,                            -- 输出文件相对 OUTPUT_DIR
    blink INTEGER NOT NULL DEFAULT 0,         -- 该张是否眨眼（模拟相机可能返回眨眼片）
    spec_compliant INTEGER NOT NULL DEFAULT 1,-- 规格符合性
    spec_issue TEXT,                          -- 不符合原因
    crop_x INTEGER, crop_y INTEGER, crop_w INTEGER, crop_h INTEGER,
    selected_at TEXT,
    FOREIGN KEY(order_id) REFERENCES orders(id)
);

CREATE TABLE IF NOT EXISTS print_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL,
    parent_job_id INTEGER,                    -- 加印任务关联原冲印任务
    is_reprint INTEGER NOT NULL DEFAULT 0,    -- 1=已冲印后的加印
    copies INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',   -- pending / printing / done / failed_no_paper / cancelled
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TEXT NOT NULL,
    done_at TEXT,
    FOREIGN KEY(order_id) REFERENCES orders(id)
);

CREATE TABLE IF NOT EXISTS pickup_attempts (
    code TEXT PRIMARY KEY,
    order_id INTEGER NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    expires_at TEXT,
    checked_at TEXT
);

CREATE TABLE IF NOT EXISTS retouch_queue (
    order_id INTEGER PRIMARY KEY,
    note TEXT,
    assigned_to TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY(order_id) REFERENCES orders(id)
);

CREATE TABLE IF NOT EXISTS retouchers_view_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    retoucher TEXT NOT NULL,
    order_id INTEGER NOT NULL,
    saw_amount INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS refunds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL,
    amount INTEGER NOT NULL,
    reason TEXT NOT NULL,
    requested_by TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',   -- pending / approved / rejected / done / duplicate
    idempotency_key TEXT NOT NULL UNIQUE,     -- 幂等键
    manager TEXT,
    reviewed_at TEXT,
    receipt_no TEXT,                          -- 付款适配器回执号
    created_at TEXT NOT NULL
);
"""

_tls = threading.local()


def now():
    return datetime.now().replace(microsecond=0).isoformat(sep=" ")


def get_conn():
    """每线程一个连接，开启外键与 WAL。"""
    conn = getattr(_tls, "conn", None)
    if conn is None:
        config.ensure_dirs()
        conn = sqlite3.connect(config.DB_PATH, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute("PRAGMA journal_mode=WAL")
        _tls.conn = conn
    return conn


def init_db(seed=True):
    conn = get_conn()
    conn.executescript(SCHEMA)
    conn.commit()
    if seed:
        seed_devices(conn)
    conn.commit()


def seed_devices(conn):
    existing = conn.execute("SELECT COUNT(*) c FROM devices").fetchone()["c"]
    if existing:
        return
    rows = [
        ("CAM-01", "1号拍摄亭", "camera", "online", 0, None),
        ("CAM-02", "2号拍摄亭", "camera", "online", 0, None),
        ("PRT-01", "1号冲印机", "printer", "online", 100, None),
        ("PRT-02", "2号冲印机", "printer", "out_of_paper", 0, None),
    ]
    conn.executemany(
        "INSERT INTO devices(id,name,kind,status,paper,locked_by) VALUES(?,?,?,?,?,?)",
        rows,
    )
