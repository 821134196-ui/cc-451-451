"""端到端服务层测试。

覆盖：设备锁、确认竞态、规格校验、加印关联、退款幂等，
以及眨眼重拍、轮次上限、裁切越界、缺纸重试、取件码失效、权限脱敏等旁路。
"""
import os
import tempfile
import threading
import unittest

# 在导入应用前指定独立数据目录（SQLite / 占位 / 输出全部隔离）
_tmp = tempfile.mkdtemp(prefix="idphoto-test-")
os.environ["IDPHOTO_DATA"] = _tmp

from app import assets, config, service  # noqa: E402
from app.adapters import camera, payment, printer  # noqa: E402
from app.database import get_conn, init_db  # noqa: E402
from app.service import ServiceError  # noqa: E402


class BaseCase(unittest.TestCase):
    def setUp(self):
        # 每个用例使用独立 DB 文件
        self.db = os.path.join(_tmp, f"case_{self._testMethodName}.db")
        os.environ["IDPHOTO_DB"] = self.db
        config.DB_PATH = self.db
        # 重置线程本地连接
        from app import database
        database._tls.__dict__.pop("conn", None)
        init_db(seed=True)
        assets.generate_all()
        # 重置适配器
        camera.set_mode("normal")
        printer.jammed.clear()
        payment.fail_next_refund = False
        payment.refunded_receipts.clear()
        # 后台重试间隔不影响用例（直接调 service）

    # -------------------------------------------------- 辅助
    def make_order(self, spec="one_inch", device="CAM-01", copies=1, retouch=0):
        return service.call_next("测试顾客", spec, device, copies, bool(retouch))

    def shoot_ok(self, oid):
        r = service.capture(oid)
        return r["photo"]

    def shoot_until(self, oid, pred):
        """不断拍摄直到候选满足 pred 或轮次耗尽，返回候选列表。"""
        o = service.get_order(oid)
        cands = []
        while o["rounds_used"] < o["max_rounds"]:
            p = self.shoot_ok(oid)
            cands.append(p)
            if pred(p):
                return p, cands
            o = service.get_order(oid)
        return None, cands


class TestDeviceLock(BaseCase):
    def test_call_locks_device_and_rejects_second_order(self):
        o1 = self.make_order(device="CAM-01")
        self.assertEqual(service.get_device("CAM-01")["locked_by"], o1["queue_no"])
        self.assertEqual(service.get_device("CAM-01")["status"], "busy")
        with self.assertRaises(ServiceError) as cm:
            self.make_order(device="CAM-01")
        self.assertEqual(cm.exception.code, "device_busy")
        # 另一台设备可用
        o2 = self.make_order(device="CAM-02")
        self.assertIsNotNone(o2["id"])

    def test_offline_device_blocks_call_and_capture_keeps_lock(self):
        o = self.make_order(device="CAM-01")
        service.set_device_status("CAM-01", "offline")
        # 离线设备不能叫新号
        with self.assertRaises(ServiceError) as cm:
            self.make_order(device="CAM-02" if False else "CAM-01")
        self.assertEqual(cm.exception.code, "device_offline")
        # 已锁定订单在设备离线时不能拍摄，但锁不释放
        with self.assertRaises(ServiceError) as cm2:
            service.capture(o["id"])
        self.assertEqual(cm2.exception.code, "device_offline")
        self.assertEqual(service.get_device("CAM-01")["locked_by"], o["queue_no"])
        # 恢复后可继续
        service.set_device_status("CAM-01", "online")
        p = self.shoot_ok(o["id"])
        self.assertTrue(p["id"] > 0)

    def test_device_released_after_confirm(self):
        o = self.make_order()
        p = self.shoot_ok(o["id"])
        service.confirm_selection(o["id"], p["id"])
        dev = service.get_device("CAM-01")
        self.assertIsNone(dev["locked_by"])
        self.assertEqual(dev["status"], "online")


class TestConfirmRace(BaseCase):
    def test_two_terminals_only_first_confirm_wins(self):
        o = self.make_order()
        photos = [self.shoot_ok(o["id"]) for _ in range(2)]
        errors, winners = [], []

        def confirm(photo_id):
            try:
                updated = service.confirm_selection(o["id"], photo_id)
                winners.append(updated["selected_photo_id"])
            except ServiceError as e:
                errors.append(e.code)

        t1 = threading.Thread(target=confirm, args=(photos[0]["id"],))
        t2 = threading.Thread(target=confirm, args=(photos[1]["id"],))
        t1.start(); t2.start(); t1.join(); t2.join()

        self.assertEqual(len(winners), 1, "必须恰好一个确认成功")
        self.assertEqual(errors.count("already_confirmed"), 1)
        final = service.get_order(o["id"])
        self.assertNotEqual(final["status"], "queued")
        self.assertEqual(final["selected_photo_id"], winners[0])
        self.assertEqual(final["confirmed_version"], 1)

    def test_double_confirm_same_terminal_also_rejected(self):
        o = self.make_order()
        p = self.shoot_ok(o["id"])
        service.confirm_selection(o["id"], p["id"])
        with self.assertRaises(ServiceError) as cm:
            service.confirm_selection(o["id"], p["id"])
        self.assertEqual(cm.exception.code, "already_confirmed")


class TestSpecValidation(BaseCase):
    def test_compliant_photo_goes_printing(self):
        o = self.make_order(spec="one_inch")
        # 变体 5 不合规，其它合规；找到一张合规片
        target = None
        for _ in range(config.MAX_ROUNDS):
            p = self.shoot_ok(o["id"])
            ok, _, _ = service.validate_spec(p, "one_inch")
            if ok:
                target = p
                break
        self.assertIsNotNone(target, "应至少拍到一张合规候选")
        updated = service.confirm_selection(o["id"], target["id"])
        self.assertEqual(updated["status"], "printing")

    def test_noncompliant_variant5_forced_retouch(self):
        o = self.make_order(spec="one_inch")
        p = self.shoot_ok(o["id"])
        ok, issues, metrics = service.validate_spec(p, o["spec_key"])
        # 不论随机到哪张，变体 5 必不合规
        bad = service.get_photo(p["id"])
        # 手工把候选素材替换为变体 5 以确定性触发
        get_conn().execute("UPDATE photos SET src_file='person_5.svg', blink=0 WHERE id=?", (p["id"],))
        get_conn().commit()
        bad = service.get_photo(p["id"])
        ok, issues, _ = service.validate_spec(bad, "one_inch")
        self.assertFalse(ok)
        self.assertTrue(issues, "应给出头高/顶距不符的原因")
        updated = service.confirm_selection(o["id"], p["id"])
        self.assertEqual(updated["status"], "retouching")
        self.assertEqual(updated["retouch_required"], 1)
        # 修正队列有条目
        q = service.list_retouch_queue()
        self.assertEqual(len(q), 1)
        # 修图人员提交后进入冲印，输出文件是修正版
        done = service.submit_retouch(o["id"], "修图员")
        self.assertEqual(done["status"], "printing")

    def test_crop_out_of_bounds_rejected(self):
        o = self.make_order()
        p = self.shoot_ok(o["id"])
        bad_crop = (-10, -10, config.RAW_W, config.RAW_H)
        with self.assertRaises(ServiceError) as cm:
            service.confirm_selection(o["id"], p["id"], crop=bad_crop)
        self.assertEqual(cm.exception.code, "crop_out_of_bounds")
        # 合法但小范围的裁切通过
        ok = service.confirm_selection(o["id"], p["id"], crop=(0, 0, 600, 800))
        self.assertIn(ok["status"], ("printing", "retouching"))

    def test_blink_flagged_and_rounds_cap(self):
        camera.set_mode("blink")
        o = self.make_order()
        r1 = service.capture(o["id"])
        self.assertEqual(r1["hint"], "检测到眨眼，建议重拍")
        self.assertTrue(r1["photo"]["blink"])
        camera.set_mode("normal")
        for _ in range(config.MAX_ROUNDS - 1):
            service.capture(o["id"])
        with self.assertRaises(ServiceError) as cm:
            service.capture(o["id"])
        self.assertEqual(cm.exception.code, "rounds_exhausted")


class TestReprintLink(BaseCase):
    def _print_done(self, o):
        p = self.shoot_ok(o["id"])
        service.confirm_selection(o["id"], p["id"])
        jobs = [j for j in service.list_print_jobs() if j["order_id"] == o["id"]]
        self.assertEqual(len(jobs), 1)
        service.process_print_job(jobs[0]["id"])
        return jobs[0]["id"]

    def test_reprint_before_print_rejected(self):
        o = self.make_order()
        p = self.shoot_ok(o["id"])
        service.confirm_selection(o["id"], p["id"])
        with self.assertRaises(ServiceError) as cm:
            service.add_reprint(o["id"], 1, "店员")
        self.assertEqual(cm.exception.code, "not_printed")

    def test_reprint_links_parent_after_print(self):
        o = self.make_order(copies=1)
        parent_id = self._print_done(o)
        self.assertEqual(service.get_order(o["id"])["status"], "completed")
        r = service.add_reprint(o["id"], 2, "店员乙")
        self.assertEqual(r["parent_job_id"], parent_id)
        jobs = service.list_print_jobs()
        child = [j for j in jobs if j["id"] == r["job_id"]][0]
        self.assertEqual(child["is_reprint"], 1)
        self.assertEqual(child["copies"], 2)
        # 执行加印，订单状态保持 completed（加印不改状态）
        service.process_print_job(child["id"])
        self.assertEqual(service.get_order(o["id"])["status"], "completed")

    def test_printed_order_cannot_reopen_selection(self):
        o = self.make_order()
        self._print_done(o)
        with self.assertRaises(ServiceError) as cm:
            service.reopen_selection(o["id"], "店员", "顾客想换一张")
        self.assertEqual(cm.exception.code, "already_printed")

    def test_reopen_requires_reason(self):
        o = self.make_order()
        p = self.shoot_ok(o["id"])
        service.confirm_selection(o["id"], p["id"])
        with self.assertRaises(ServiceError) as cm:
            service.reopen_selection(o["id"], "店员", "  ")
        self.assertEqual(cm.exception.code, "reason_required")
        reopened = service.reopen_selection(o["id"], "店员", "顾客确认选错")
        self.assertEqual(reopened["status"], "queued")
        self.assertEqual(reopened["reopen_reason"], "顾客确认选错")


class TestRefundIdempotency(BaseCase):
    def test_refund_request_idempotent(self):
        o = self.make_order()
        a = service.request_refund(o["id"], o["amount"], "顾客误操作", "前台", "KEY-1")
        b = service.request_refund(o["id"], o["amount"], "顾客误操作", "前台", "KEY-1")
        self.assertEqual(a["id"], b["id"])
        self.assertTrue(b.get("reused"))
        rows = service.list_refunds()
        self.assertEqual(len([r for r in rows if r["order_id"] == o["id"]]), 1)

    def test_review_requires_manager_and_double_review_no_double_refund(self):
        o = self.make_order()
        r = service.request_refund(o["id"], o["amount"], "设备故障", "前台", "KEY-2")
        with self.assertRaises(ServiceError) as cm:
            service.review_refund(r["id"], "", True)
        self.assertEqual(cm.exception.code, "manager_required")

        done = service.review_refund(r["id"], "王店长", True)
        self.assertEqual(done["status"], "done")
        self.assertIn(done["receipt_no"], payment.refunded_receipts)
        self.assertEqual(service.get_order(o["id"])["status"], "cancelled")

        # 通道瞬时失败标志打开也不影响已完成单据：重复审核返回原单
        again = service.review_refund(r["id"], "王店长", True)
        self.assertTrue(again.get("reused"))
        self.assertEqual(len(payment.refunded_receipts), 1, "不得重复打款")

    def test_channel_timeout_keeps_pending_and_retry_succeeds(self):
        o = self.make_order()
        r = service.request_refund(o["id"], o["amount"], "误操作", "前台", "KEY-3")
        payment.fail_next_refund = True
        with self.assertRaises(ServiceError) as cm:
            service.review_refund(r["id"], "王店长", True)
        self.assertEqual(cm.exception.code, "channel_failed")
        still = service.list_refunds()[0]
        self.assertEqual(still["status"], "pending")
        # 幂等重试成功
        done = service.review_refund(r["id"], "王店长", True)
        self.assertEqual(done["status"], "done")

    def test_reject_path(self):
        o = self.make_order()
        r = service.request_refund(o["id"], 100, "误操作", "前台", "KEY-4")
        out = service.review_refund(r["id"], "王店长", False)
        self.assertEqual(out["status"], "rejected")
        self.assertEqual(service.get_order(o["id"])["status"], "queued")


class TestAuxiliaryPaths(BaseCase):
    def test_pickup_code_issue_expire_reissue(self):
        o = self.make_order()
        p = self.shoot_ok(o["id"])
        service.confirm_selection(o["id"], p["id"])
        job = [j for j in service.list_print_jobs() if j["order_id"] == o["id"]][0]
        service.process_print_job(job["id"])
        pc = service.get_active_pickup_code(o["id"])
        self.assertIsNotNone(pc)
        # 正常取件
        picked = service.verify_pickup(pc["code"])
        self.assertEqual(picked["status"], "picked")
        # 同一码不能重复取件
        with self.assertRaises(ServiceError) as cm:
            service.verify_pickup(pc["code"])
        self.assertEqual(cm.exception.code, "already_picked")
        # 店员重签
        code2 = service.reissue_pickup_code(o["id"], "店员")
        self.assertNotEqual(code2, pc["code"])
        # 手工把码置过期，后台扫描失效后核验报错
        get_conn().execute("UPDATE pickup_attempts SET expires_at=? WHERE code=?",
                           ("2000-01-01 00:00:00", code2))
        get_conn().commit()
        n = service.expire_pickup_codes()
        self.assertGreaterEqual(n, 1)
        with self.assertRaises(ServiceError) as cm:
            service.verify_pickup(code2)
        self.assertIn(cm.exception.code, ("code_expired", "code_invalid"))
        # 不存在的码
        with self.assertRaises(ServiceError) as cm:
            service.verify_pickup("999999")
        self.assertEqual(cm.exception.code, "code_not_found")

    def test_no_paper_then_retry(self):
        o = self.make_order()
        p = self.shoot_ok(o["id"])
        service.confirm_selection(o["id"], p["id"])
        job = [j for j in service.list_print_jobs() if j["order_id"] == o["id"]][0]
        # 全部冲印机缺纸
        for d in service.list_devices("printer"):
            get_conn().execute(
                "UPDATE devices SET status='out_of_paper', paper=0 WHERE id=?", (d["id"],))
        get_conn().commit()
        r = service.process_print_job(job["id"])
        self.assertEqual(r["result"], "failed_no_paper")
        # 加纸后后台重试成功
        service.add_paper("PRT-01", 50)
        results = service.retry_due_prints()
        self.assertTrue(any(x.get("result") == "done" for x in results))
        self.assertEqual(service.get_order(o["id"])["status"], "completed")

    def test_retoucher_view_has_no_payment_fields(self):
        o = self.make_order()
        dto = service.order_dto_for_retoucher(o["id"], "修图员")
        for secret in ("amount", "paid", "payment_receipt", "pickup_code_hash"):
            self.assertNotIn(secret, dto)
        # 审计日志记录且未看到金额
        row = get_conn().execute(
            "SELECT saw_amount FROM retouchers_view_log ORDER BY id DESC LIMIT 1").fetchone()
        self.assertEqual(row["saw_amount"], 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
