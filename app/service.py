"""业务服务层：排队叫号、设备锁、拍摄轮次、候选确认竞态、
规格/裁切校验、人工修正、冲印与加印、取件码、退款幂等。

所有写操作在 SQLite 事务内完成；并发依赖 BEGIN IMMEDIATE 串行化。
"""
import hashlib
import os
import secrets
import sqlite3
import threading
from datetime import datetime, timedelta

from . import assets, config
from .adapters import camera, payment, printer
from .database import get_conn, now

# 订单状态
QUEUED, SELECTED, RETOUCHING, PRINTING, COMPLETED, PICKED, CANCELLED = (
    "queued", "selected", "retouching", "printing", "completed", "picked", "cancelled",
)
# 打印任务状态
J_PENDING, J_DONE, J_NO_PAPER, J_FAILED, J_CANCELLED = (
    "pending", "done", "failed_no_paper", "failed", "cancelled",
)

# 已冲印后仍允许的操作受限：以“存在 done 冲印任务”为界
PRINTED_STATUSES = (COMPLETED, PICKED)


class ServiceError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


# ---------------------------------------------------------------- 设备

def list_devices(kind=None):
    conn = get_conn()
    sql = "SELECT * FROM devices"
    args = ()
    if kind:
        sql += " WHERE kind=?"
        args = (kind,)
    sql += " ORDER BY id"
    return [dict(r) for r in conn.execute(sql, args)]


def get_device(device_id):
    row = get_conn().execute("SELECT * FROM devices WHERE id=?", (device_id,)).fetchone()
    if not row:
        raise ServiceError("device_not_found", f"设备 {device_id} 不存在")
    return dict(row)


def set_device_status(device_id, status):
    assert status in ("online", "offline", "out_of_paper")
    conn = get_conn()
    with conn:
        conn.execute("UPDATE devices SET status=? WHERE id=?", (status, device_id))
    return get_device(device_id)


def add_paper(device_id, n):
    conn = get_conn()
    with conn:
        dev = get_device(device_id)
        new_paper = dev["paper"] + n
        new_status = "online" if new_paper > 0 and dev["status"] == "out_of_paper" else dev["status"]
        conn.execute("UPDATE devices SET paper=?, status=? WHERE id=?",
                     (new_paper, new_status, device_id))
    return get_device(device_id)


# ---------------------------------------------------------------- 下单 / 叫号

_queue_lock = threading.Lock()


def _next_queue_no(conn):
    d = datetime.now()
    prefix = f"{d.month:02d}{d.day:02d}"
    row = conn.execute(
        "SELECT COUNT(*) c FROM orders WHERE queue_no LIKE ?", (prefix + "%",)
    ).fetchone()
    return f"{prefix}-{row['c'] + 1:03d}"


def price_for(spec_key, copies):
    # 模拟定价：规格基础价（分）+ 加份
    base = {"one_inch": 2500, "two_inch": 3000, "id_card": 2000, "passport": 3500}[spec_key]
    return base + (copies - 1) * 1000


def call_next(customer_name, spec_key, device_id, copies=1, retouch_required=False):
    """叫号：校验设备在线且空闲 -> 锁定拍摄设备 -> 建单（模拟付款完成）。"""
    if spec_key not in config.SPECS:
        raise ServiceError("bad_spec", "证件规格不存在")
    if copies < 1:
        raise ServiceError("bad_copies", "冲印份数至少 1")
    conn = get_conn()
    with _queue_lock, conn:
        conn.execute("BEGIN IMMEDIATE")
        dev = conn.execute("SELECT * FROM devices WHERE id=?", (device_id,)).fetchone()
        if not dev:
            raise ServiceError("device_not_found", "拍摄设备不存在")
        if dev["kind"] != "camera":
            raise ServiceError("not_a_camera", "该设备不是拍摄设备")
        if dev["status"] == "offline":
            raise ServiceError("device_offline", "拍摄设备离线，无法叫号")
        if dev["locked_by"]:
            raise ServiceError("device_busy", f"设备已被排队号 {dev['locked_by']} 占用")
        amount = price_for(spec_key, copies)
        pay = payment.pay(amount)  # 模拟付款回执
        qno = _next_queue_no(conn)
        ts = now()
        cur = conn.execute(
            """INSERT INTO orders(queue_no,customer_name,spec_key,max_rounds,status,
                  device_id,copies,amount,paid,payment_receipt,retouch_required,created_at,updated_at)
               VALUES(?,?,?,?,?,?,?,?,1,?,?,?,?)""",
            (qno, customer_name, spec_key, config.MAX_ROUNDS, QUEUED, device_id,
             copies, amount, pay["receipt_no"], 1 if retouch_required else 0, ts, ts),
        )
        order_id = cur.lastrowid
        conn.execute("UPDATE devices SET status='busy', locked_by=? WHERE id=?",
                     (qno, device_id))
    return get_order(order_id)


def _release_device(conn, device_id):
    conn.execute("UPDATE devices SET status='online', locked_by=NULL WHERE id=?", (device_id,))


def get_order(order_id):
    row = get_conn().execute("SELECT * FROM orders WHERE id=?", (order_id,)).fetchone()
    if not row:
        raise ServiceError("order_not_found", f"订单 {order_id} 不存在")
    return dict(row)


def find_order_by_queue(qno):
    row = get_conn().execute("SELECT * FROM orders WHERE queue_no=?", (qno,)).fetchone()
    if not row:
        raise ServiceError("order_not_found", f"排队号 {qno} 不存在")
    return dict(row)


def list_orders(status=None):
    sql = "SELECT * FROM orders"
    args = ()
    if status:
        sql += " WHERE status=?"
        args = (status,)
    sql += " ORDER BY id DESC"
    return [dict(r) for r in get_conn().execute(sql, args)]


def order_dto_for_retoucher(order_id, retoucher):
    """修图人员视图：不含任何付款明细（金额/付款状态/回执），并记录审计日志。"""
    o = get_order(order_id)
    conn = get_conn()
    with conn:
        conn.execute(
            "INSERT INTO retouchers_view_log(retoucher,order_id,saw_amount,created_at) VALUES(?,?,0,?)",
            (retoucher, order_id, now()),
        )
    return {
        "id": o["id"], "queue_no": o["queue_no"], "customer_name": o["customer_name"],
        "spec_key": o["spec_key"], "status": o["status"],
        "retouch_required": o["retouch_required"],
        "copies": o["copies"],
    }


# ---------------------------------------------------------------- 拍摄

def capture(order_id):
    """拍摄一张候选片。处理：设备离线、轮次上限、眨眼片（需重拍但不占额外惩罚——
    眨眼片仍计入一轮候选，顾客可选择重拍）。"""
    conn = get_conn()
    with conn:
        conn.execute("BEGIN IMMEDIATE")
        o = conn.execute("SELECT * FROM orders WHERE id=?", (order_id,)).fetchone()
        if not o:
            raise ServiceError("order_not_found", "订单不存在")
        if o["status"] != QUEUED:
            raise ServiceError("not_capturable", f"订单状态为 {o['status']}，不能拍摄")
        dev = conn.execute("SELECT * FROM devices WHERE id=?", (o["device_id"],)).fetchone()
        if dev["status"] == "offline":
            raise ServiceError("device_offline",
                               "拍摄设备已离线，请改由其他设备或等待恢复（设备保持锁定）")
        if o["rounds_used"] >= o["max_rounds"]:
            raise ServiceError("rounds_exhausted",
                               f"已达 {o['max_rounds']} 轮上限，请从候选中选定一张")
        shot = camera.capture(order_id, o["rounds_used"] + 1)
        # 模拟对眨眼片的现场检测
        blink = 1 if shot["blink"] else 0
        cur = conn.execute(
            """INSERT INTO photos(order_id,round,kind,src_file,blink,spec_compliant)
               VALUES(?,?, 'raw', ?, ?, 1)""",
            (order_id, o["rounds_used"] + 1, shot["src_file"], blink),
        )
        conn.execute("UPDATE orders SET rounds_used=rounds_used+1, updated_at=? WHERE id=?",
                     (now(), order_id))
        photo_id = cur.lastrowid
    return {"photo": get_photo(photo_id),
            "hint": "检测到眨眼，建议重拍" if get_photo(photo_id)["blink"] else None}


def get_photo(photo_id):
    row = get_conn().execute("SELECT * FROM photos WHERE id=?", (photo_id,)).fetchone()
    if not row:
        raise ServiceError("photo_not_found", "照片不存在")
    return dict(row)


def list_candidates(order_id):
    rows = get_conn().execute(
        "SELECT * FROM photos WHERE order_id=? AND kind='raw' ORDER BY id", (order_id,)
    ).fetchall()
    return [dict(r) for r in rows]


# ------------------------------------------------------- 规格 / 裁切校验

# 占位素材中“标准人脸”的几何（原始像素，见 assets.VARIANTS 1/2/3/4）
REF_HEAD_TOP = 300
REF_HEAD_H = 560


def crop_box(spec_key):
    """规格在原始 1200x1600 画布上的居中裁切框（原始像素）。

    以标准人脸为基准，让头高/头顶留白落在规格区间中值，反推裁切框；
    变体 1-4 因此合规，头部过大的变体 5 不合规。
    """
    s = config.SPECS[spec_key]
    mid_head = (s["head_mm_min"] + s["head_mm_max"]) / 2
    mid_top = (s["head_top_mm_min"] + s["head_top_mm_max"]) / 2
    raw_per_mm = REF_HEAD_H / mid_head
    h = int(raw_per_mm * s["mm_h"])
    w = int(raw_per_mm * s["mm_w"])
    x = (config.RAW_W - w) // 2
    y = int(REF_HEAD_TOP - raw_per_mm * mid_top)
    return x, y, w, h


def crop_in_bounds(crop):
    x, y, w, h = crop
    return (x >= 0 and y >= 0 and w > 0 and h > 0
            and x + w <= config.RAW_W and y + h <= config.RAW_H)


def validate_spec(photo, spec_key):
    """返回 (ok, issues[], metrics)。metrics 为毫米测量值。"""
    s = config.SPECS[spec_key]
    variant = assets.variant_from_file(photo["src_file"])
    head_top_px, head_h_px = assets.face_meta(variant)
    x0, y0, w, h = crop_box(spec_key)
    raw_per_mm = h / s["mm_h"]  # 裁切框原始像素 / 成品毫米
    top_mm = (head_top_px - y0) / raw_per_mm
    head_mm = head_h_px / raw_per_mm
    issues = []
    if not (s["head_mm_min"] <= head_mm <= s["head_mm_max"]):
        issues.append(f"头部高度 {head_mm:.1f}mm 超出 {s['head_mm_min']}-{s['head_mm_max']}mm")
    if not (s["head_top_mm_min"] <= top_mm <= s["head_top_mm_max"]):
        issues.append(f"头顶留白 {top_mm:.1f}mm 超出 {s['head_top_mm_min']}-{s['head_top_mm_max']}mm")
    return (len(issues) == 0, issues,
            {"head_mm": round(head_mm, 1), "top_mm": round(top_mm, 1)})


def spec_preview(order_id):
    """规格预览数据：毫米尺寸、裁切安全线、各候选的规格符合性。"""
    o = get_order(order_id)
    s = config.SPECS[o["spec_key"]]
    crop = crop_box(o["spec_key"])
    cands = []
    for p in list_candidates(order_id):
        ok, issues, metrics = validate_spec(p, o["spec_key"])
        cands.append({"photo": p, "ok": ok, "issues": issues, "metrics": metrics})
    return {
        "spec": {"key": o["spec_key"], "name": s["name"], "mm_w": s["mm_w"], "mm_h": s["mm_h"],
                 "dpi": s["dpi"]},
        "crop": {"x": crop[0], "y": crop[1], "w": crop[2], "h": crop[3],
                 "raw_w": config.RAW_W, "raw_h": config.RAW_H},
        "candidates": cands,
    }


def _write_crop(order_id, photo, crop, label, kind="cropped", border=False):
    variant = assets.variant_from_file(photo["src_file"])
    blink = bool(photo.get("blink"))
    x, y, w, h = crop
    name = f"order{order_id}_photo{photo['id']}_{kind}.svg"
    path = os.path.join(config.OUTPUT_DIR, name)
    with open(path, "w", encoding="utf-8") as f:
        f.write(assets.cropped_svg(variant, blink, crop, label, border))
    return name


# ---------------------------------------------------------------- 确认选片

def confirm_selection(order_id, photo_id, crop=None, client_token=None):
    """顾客确认候选。两台终端同时确认只接收首个版本。

    成功：写裁切输出，订单 selected；后续根据是否需修正进入 retouching/printing。
    crop 可由前端微调；越界拒绝。
    """
    conn = get_conn()
    with conn:
        conn.execute("BEGIN IMMEDIATE")
        o = conn.execute("SELECT * FROM orders WHERE id=?", (order_id,)).fetchone()
        if not o:
            raise ServiceError("order_not_found", "订单不存在")
        if o["status"] != QUEUED:
            winner = conn.execute("SELECT * FROM photos WHERE id=?", (o["selected_photo_id"],)).fetchone()
            raise ServiceError(
                "already_confirmed",
                f"该订单已由另一终端确认（候选 #{winner['id'] if winner else '?'}），只接收首个版本",
            )
        photo = conn.execute(
            "SELECT * FROM photos WHERE id=? AND order_id=? AND kind='raw'",
            (photo_id, order_id),
        ).fetchone()
        if not photo:
            raise ServiceError("photo_not_found", "候选照片不存在或不属于本订单")
        box = crop_box(o["spec_key"])
        if crop is not None:
            box = tuple(int(v) for v in crop)
            if len(box) != 4 or not crop_in_bounds(box):
                raise ServiceError("crop_out_of_bounds",
                                   "裁切框越界，请保持在原始画面范围内")
        # 规格不符：仍允许顾客确认，但必须走人工修正
        ok, issues, _ = validate_spec(dict(photo), o["spec_key"])
        forced_retouch = 0 if ok else 1
        out_name = _write_crop(order_id, dict(photo), box,
                               f"{config.SPECS[o['spec_key']]['name']} 裁切版")
        conn.execute(
            """UPDATE photos SET kind='cropped', crop_x=?,crop_y=?,crop_w=?,crop_h=?,
                  out_file=?, spec_compliant=?, spec_issue=?, selected_at=? WHERE id=?""",
            (box[0], box[1], box[2], box[3], out_name, 1 if ok else 0,
             "; ".join(issues) or None, now(), photo["id"]),
        )
        need_retouch = 1 if (o["retouch_required"] or forced_retouch) else 0
        new_status = RETOUCHING if need_retouch else PRINTING
        conn.execute(
            """UPDATE orders SET selected_photo_id=?, confirmed_version=1,
                  retouch_required=?, status=?, updated_at=? WHERE id=?""",
            (photo["id"], need_retouch, new_status, now(), order_id),
        )
        if new_status == RETOUCHING:
            conn.execute(
                "INSERT OR IGNORE INTO retouch_queue(order_id,note,created_at) VALUES(?,?,?)",
                (order_id, "; ".join(issues) or "顾客要求人工修正", now()),
            )
        else:
            _enqueue_print(conn, order_id, o["copies"], is_reprint=0, parent=None)
        _release_device(conn, o["device_id"])
    return get_order(order_id)


def reopen_selection(order_id, staff, reason):
    """店员重开顾客选择：必须写原因；已冲印（存在 done 任务）的订单禁止改选。"""
    if not reason or not reason.strip():
        raise ServiceError("reason_required", "店员重开选择必须填写原因")
    conn = get_conn()
    with conn:
        conn.execute("BEGIN IMMEDIATE")
        o = conn.execute("SELECT * FROM orders WHERE id=?", (order_id,)).fetchone()
        done_job = conn.execute(
            "SELECT 1 FROM print_jobs WHERE order_id=? AND status='done' LIMIT 1", (order_id,)
        ).fetchone()
        if done_job:
            raise ServiceError("already_printed",
                               "订单已冲印，不能改选原片；请创建加印任务")
        if o["status"] not in (SELECTED, RETOUCHING, PRINTING):
            raise ServiceError("bad_status", f"状态 {o['status']} 不支持重开选择")
        # 旧冲印任务作废
        conn.execute("UPDATE print_jobs SET status='cancelled' WHERE order_id=? AND status='pending'",
                     (order_id,))
        conn.execute("DELETE FROM retouch_queue WHERE order_id=?", (order_id,))
        conn.execute(
            """UPDATE orders SET status='queued', selected_photo_id=NULL, confirmed_version=0,
                  retouch_required=0, selection_reopened_by=?, reopen_reason=?, updated_at=? WHERE id=?""",
            (staff, reason.strip(), now(), order_id),
        )
        # 恢复候选为 raw、重新锁定原设备（若空闲）
        conn.execute("UPDATE photos SET kind='raw', selected_at=NULL WHERE order_id=?", (order_id,))
        conn.execute("UPDATE devices SET status='busy', locked_by=? WHERE id=?",
                     (o["queue_no"], o["device_id"]))
    return get_order(order_id)


# ---------------------------------------------------------------- 人工修正

def list_retouch_queue():
    rows = get_conn().execute(
        """SELECT r.*, o.queue_no, o.customer_name, o.spec_key, o.selected_photo_id
           FROM retouch_queue r JOIN orders o ON o.id=r.order_id
           WHERE o.status='retouching' ORDER BY r.rowid""").fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["photo"] = get_photo(d["selected_photo_id"])
        out.append(d)
    return out


def submit_retouch(order_id, retoucher, note=""):
    """修图人员提交修正版：基于裁切版生成“已修正”输出，流转待冲印。

    修图人员全程不接触付款字段（见 order_dto_for_retoucher）。
    """
    conn = get_conn()
    with conn:
        conn.execute("BEGIN IMMEDIATE")
        o = conn.execute("SELECT * FROM orders WHERE id=?", (order_id,)).fetchone()
        if not o or o["status"] != RETOUCHING:
            raise ServiceError("bad_status", "订单不在待修正状态")
        src = get_photo(o["selected_photo_id"])
        crop = (src["crop_x"], src["crop_y"], src["crop_w"], src["crop_h"])
        name = f"order{order_id}_photo{src['id']}_retouched.svg"
        path = os.path.join(config.OUTPUT_DIR, name)
        with open(path, "w", encoding="utf-8") as f:
            f.write(assets.cropped_svg(
                assets.variant_from_file(src["src_file"]), bool(src["blink"]),
                crop, "人工修正版", border=True))
        conn.execute(
            """UPDATE photos SET kind='retouched', out_file=?, spec_compliant=1, spec_issue=NULL
               WHERE id=?""",
            (name, src["id"]),
        )
        conn.execute("DELETE FROM retouch_queue WHERE order_id=?", (order_id,))
        conn.execute("UPDATE orders SET status='printing', retouched_photo_id=?, updated_at=? WHERE id=?",
                     (src["id"], now(), order_id))
        _enqueue_print(conn, order_id, o["copies"], is_reprint=0, parent=None)
    return get_order(order_id)


# ---------------------------------------------------------------- 冲印

def _enqueue_print(conn, order_id, copies, is_reprint, parent):
    ts = now()
    cur = conn.execute(
        """INSERT INTO print_jobs(order_id,parent_job_id,is_reprint,copies,status,created_at)
           VALUES(?,?,?,?, 'pending', ?)""",
        (order_id, parent, 1 if is_reprint else 0, copies, ts),
    )
    return cur.lastrowid


def list_print_jobs(status=None):
    sql = ("""SELECT j.*, o.queue_no, o.spec_key FROM print_jobs j
              JOIN orders o ON o.id=j.order_id""")
    args = ()
    if status:
        sql += " WHERE j.status=?"
        args = (status,)
    sql += " ORDER BY j.id"
    return [dict(r) for r in get_conn().execute(sql, args)]


def _pick_printer(conn, copies):
    return conn.execute(
        "SELECT * FROM devices WHERE kind='printer' AND status='online' AND paper>=? ORDER BY id LIMIT 1",
        (copies,),
    ).fetchone()


def process_print_job(job_id, device_id=None):
    """执行冲印。缺纸 -> failed_no_paper 进入后台重试；其他失败 -> failed。"""
    conn = get_conn()
    with conn:
        conn.execute("BEGIN IMMEDIATE")
        job = conn.execute("SELECT * FROM print_jobs WHERE id=?", (job_id,)).fetchone()
        if not job or job["status"] not in (J_PENDING, J_NO_PAPER, J_FAILED):
            raise ServiceError("job_not_runnable", "该冲印任务当前不可执行")
        o = conn.execute("SELECT * FROM orders WHERE id=?", (job["order_id"],)).fetchone()
        dev = None
        if device_id:
            dev = conn.execute("SELECT * FROM devices WHERE id=?", (device_id,)).fetchone()
        if dev is None:
            dev = _pick_printer(conn, job["copies"])
        if dev is None:
            conn.execute(
                "UPDATE print_jobs SET status='failed_no_paper', attempts=attempts+1, last_error=? WHERE id=?",
                ("没有可用且纸张充足的冲印机（打印缺纸）", job_id),
            )
            return {"job_id": job_id, "result": "failed_no_paper"}
        result = printer.print(dict(dev), job["copies"],
                               get_photo(o["selected_photo_id"])["out_file"])
        if result["ok"]:
            conn.execute("UPDATE devices SET paper=paper-? WHERE id=?", (job["copies"], dev["id"]))
            conn.execute(
                "UPDATE print_jobs SET status='done', attempts=attempts+1, last_error=NULL, done_at=? WHERE id=?",
                (now(), job_id),
            )
            _after_print_done(conn, o)
            return {"job_id": job_id, "result": "done", "device": dev["id"]}
        err = result["error"]
        if "缺纸" in err:
            conn.execute("UPDATE devices SET status='out_of_paper', paper=0 WHERE id=?", (dev["id"],))
            conn.execute(
                "UPDATE print_jobs SET status='failed_no_paper', attempts=attempts+1, last_error=? WHERE id=?",
                (err, job_id),
            )
            return {"job_id": job_id, "result": "failed_no_paper", "error": err}
        conn.execute(
            "UPDATE print_jobs SET status='failed', attempts=attempts+1, last_error=? WHERE id=?",
            (err, job_id),
        )
        return {"job_id": job_id, "result": "failed", "error": err}


def _after_print_done(conn, o):
    """原始冲印任务全部完成 -> 订单 completed 并签发取件码。加印不改变订单状态。"""
    pending = conn.execute(
        "SELECT COUNT(*) c FROM print_jobs WHERE order_id=? AND status!='done' AND status!='cancelled'",
        (o["id"],),
    ).fetchone()["c"]
    if pending:
        return
    if o["status"] == PRINTING:
        conn.execute("UPDATE orders SET status='completed', updated_at=? WHERE id=?", (now(), o["id"]))
        _issue_pickup_code(conn, o["id"])


def add_reprint(order_id, copies, staff):
    """加印：仅对已冲印（存在 done 任务）的订单开放，关联原冲印任务。"""
    if copies < 1:
        raise ServiceError("bad_copies", "加印份数至少 1")
    conn = get_conn()
    with conn:
        conn.execute("BEGIN IMMEDIATE")
        o = conn.execute("SELECT * FROM orders WHERE id=?", (order_id,)).fetchone()
        parent = conn.execute(
            "SELECT * FROM print_jobs WHERE order_id=? AND is_reprint=0 AND status='done' ORDER BY id DESC LIMIT 1",
            (order_id,),
        ).fetchone()
        if not parent:
            raise ServiceError("not_printed", "订单尚未冲印，不能加印；普通冲印将在确认后自动进行")
        if o["status"] == CANCELLED:
            raise ServiceError("order_cancelled", "订单已退款取消")
        job_id = _enqueue_print(conn, order_id, copies, is_reprint=1, parent=parent["id"])
        conn.execute("UPDATE orders SET updated_at=? WHERE id=?", (now(), order_id))
    return {"job_id": job_id, "parent_job_id": parent["id"]}


def retry_due_prints():
    """后台调用：重试缺纸/失败且未超次数的任务。"""
    conn = get_conn()
    rows = conn.execute(
        "SELECT id FROM print_jobs WHERE status IN ('failed_no_paper','failed') AND attempts<?",
        (config.PRINT_MAX_RETRY,),
    ).fetchall()
    results = []
    for r in rows:
        try:
            results.append(process_print_job(r["id"]))
        except ServiceError as e:
            results.append({"job_id": r["id"], "result": "skip", "error": e.message})
    return results


# ---------------------------------------------------------------- 取件码

def _issue_pickup_code(conn, order_id):
    code = f"{secrets.randbelow(10**6):06d}"
    deadline = (datetime.now() + timedelta(seconds=config.PICKUP_CODE_TTL)
                ).replace(microsecond=0).isoformat(sep=" ")
    h = hashlib.sha256(code.encode()).hexdigest()
    conn.execute(
        """UPDATE orders SET pickup_code_hash=?, pickup_active=1, pickup_deadline=? WHERE id=?""",
        (h, deadline, order_id),
    )
    conn.execute(
        "INSERT OR REPLACE INTO pickup_attempts(code,order_id,active,expires_at) VALUES(?,?,1,?)",
        (code, order_id, deadline),
    )
    return code


def get_active_pickup_code(order_id):
    """店员侧查看当前有效取件码（明文仅存于 pickup_attempts）。"""
    o = get_order(order_id)
    row = get_conn().execute(
        "SELECT code, expires_at, active FROM pickup_attempts WHERE order_id=? AND active=1",
        (order_id,),
    ).fetchone()
    if not row:
        return None
    return {"code": row["code"], "expires_at": row["expires_at"]}


def expire_pickup_codes():
    """后台调用：过期取件码置失效。"""
    conn = get_conn()
    with conn:
        cur = conn.execute(
            """UPDATE pickup_attempts SET active=0 WHERE active=1 AND expires_at<=?""",
            (now(),),
        )
        n = cur.rowcount
        conn.execute(
            """UPDATE orders SET pickup_active=0 WHERE pickup_active=1 AND pickup_deadline<=?""",
            (now(),),
        )
    return n


def verify_pickup(code):
    """取件核验：有效 -> 订单置 picked；失效 -> 明确提示。"""
    conn = get_conn()
    with conn:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute("SELECT * FROM pickup_attempts WHERE code=?", (code,)).fetchone()
        if not row:
            raise ServiceError("code_not_found", "取件码不存在，请核对后重试")
        o = conn.execute("SELECT * FROM orders WHERE id=?", (row["order_id"],)).fetchone()
        if o["status"] == PICKED:
            raise ServiceError("already_picked", "该订单已取件，请勿重复核验")
        if not row["active"]:
            raise ServiceError("code_invalid", "取件码已失效，请到柜台由店员重新签发")
        if row["expires_at"] <= now():
            conn.execute("UPDATE pickup_attempts SET active=0 WHERE code=?", (code,))
            conn.execute("UPDATE orders SET pickup_active=0 WHERE id=?", (row["order_id"],))
            raise ServiceError("code_expired", "取件码已过期，请到柜台由店员重新签发")
        o = conn.execute("SELECT * FROM orders WHERE id=?", (row["order_id"],)).fetchone()
        if o["status"] != COMPLETED:
            raise ServiceError("not_ready", "照片尚未冲印完成，请稍候")
        conn.execute("UPDATE orders SET status='picked', picked_at=?, updated_at=? WHERE id=?",
                     (now(), now(), o["id"]))
        conn.execute("UPDATE pickup_attempts SET active=0, checked_at=? WHERE code=?",
                     (now(), code))
    return get_order(row["order_id"])


def reissue_pickup_code(order_id, staff):
    """店员对已完成订单重新签发取件码。"""
    conn = get_conn()
    with conn:
        conn.execute("BEGIN IMMEDIATE")
        o = conn.execute("SELECT * FROM orders WHERE id=?", (order_id,)).fetchone()
        if o["status"] not in (COMPLETED, PICKED):
            raise ServiceError("not_completed", "订单未完成，不能签发取件码")
        conn.execute("UPDATE pickup_attempts SET active=0 WHERE order_id=?", (order_id,))
        if o["status"] == PICKED:
            conn.execute("UPDATE orders SET status='completed', picked_at=NULL WHERE id=?", (order_id,))
        code = _issue_pickup_code(conn, order_id)
    return code


# ---------------------------------------------------------------- 退款

def request_refund(order_id, amount, reason, requested_by, idem_key):
    """店员发起退款（误操作退款路径）。幂等：同一 idem_key 返回既有单据。"""
    if not reason or not reason.strip():
        raise ServiceError("reason_required", "退款必须填写原因")
    conn = get_conn()
    existing = conn.execute(
        "SELECT * FROM refunds WHERE idempotency_key=?", (idem_key,)
    ).fetchone()
    if existing:
        d = dict(existing)
        d["reused"] = True
        return d
    with conn:
        conn.execute("BEGIN IMMEDIATE")
        o = conn.execute("SELECT * FROM orders WHERE id=?", (order_id,)).fetchone()
        if not o:
            raise ServiceError("order_not_found", "订单不存在")
        if o["status"] == CANCELLED:
            raise ServiceError("already_refunded", "订单已退款取消")
        if o["status"] == PICKED:
            raise ServiceError("already_picked", "已取件订单不可退款")
        if amount <= 0 or amount > o["amount"]:
            raise ServiceError("bad_amount", f"退款金额需在 0.01 ~ {o['amount']/100:.2f} 元之间")
        try:
            cur = conn.execute(
                """INSERT INTO refunds(order_id,amount,reason,requested_by,status,idempotency_key,created_at)
                   VALUES(?,?,?,?,'pending',?,?)""",
                (order_id, amount, reason.strip(), requested_by, idem_key, now()),
            )
        except sqlite3.IntegrityError:
            # 并发重复提交：回查既有单据，保持幂等
            d = dict(conn.execute(
                "SELECT * FROM refunds WHERE idempotency_key=?", (idem_key,)).fetchone())
            d["reused"] = True
            return d
        rid = cur.lastrowid
    return dict(conn.execute("SELECT * FROM refunds WHERE id=?", (rid,)).fetchone())


def list_refunds(status=None):
    sql = ("""SELECT r.*, o.queue_no, o.status AS order_status FROM refunds r
              JOIN orders o ON o.id=r.order_id""")
    args = ()
    if status:
        sql += " WHERE r.status=?"
        args = (status,)
    sql += " ORDER BY r.id DESC"
    return [dict(r) for r in get_conn().execute(sql, args)]


def review_refund(refund_id, manager, approve):
    """店长审核。审核通过即调用付款适配器退款；重复调用保持幂等。"""
    if not manager or not manager.strip():
        raise ServiceError("manager_required", "退款需要店长审核")
    conn = get_conn()
    with conn:
        conn.execute("BEGIN IMMEDIATE")
        r = conn.execute("SELECT * FROM refunds WHERE id=?", (refund_id,)).fetchone()
        if not r:
            raise ServiceError("refund_not_found", "退款单不存在")
        if r["status"] in ("approved", "done"):
            d = dict(r)
            d["reused"] = True
            return d
        if not approve:
            conn.execute("UPDATE refunds SET status='rejected', manager=?, reviewed_at=? WHERE id=?",
                         (manager, now(), refund_id))
            return dict(conn.execute("SELECT * FROM refunds WHERE id=?", (refund_id,)).fetchone())
        o = conn.execute("SELECT * FROM orders WHERE id=?", (r["order_id"],)).fetchone()
        if not o["paid"] or not o["payment_receipt"]:
            raise ServiceError("not_paid", "订单无付款回执，无法退款")
        res = payment.refund(o["payment_receipt"], r["amount"])
        if not res["ok"] and not res.get("dup"):
            # 通道瞬时失败：保持 pending，可再次审核重试（幂等键防重复打款）
            raise ServiceError("channel_failed", res["error"])
        conn.execute(
            "UPDATE refunds SET status='done', manager=?, reviewed_at=?, receipt_no=? WHERE id=?",
            (manager, now(), o["payment_receipt"], refund_id),
        )
        conn.execute(
            "UPDATE orders SET status='cancelled', updated_at=? WHERE id=? AND status!='picked'",
            (now(), o["id"]),
        )
        # 取消未完成的冲印任务、释放拍摄设备（若仍占着）
        conn.execute(
            "UPDATE print_jobs SET status='cancelled' WHERE order_id=? AND status IN ('pending','failed_no_paper','failed')",
            (o["id"],),
        )
        if o["device_id"]:
            _release_device(conn, o["device_id"])
    return dict(conn.execute("SELECT * FROM refunds WHERE id=?", (refund_id,)).fetchone())
