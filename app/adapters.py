"""模拟适配器：相机、打印机、付款。

全部为进程内模拟，不连接真实硬件/支付通道。返回统一结构：
{"ok": bool, "data": ..., "error": str|None, "receipt_no": ...}
"""
import itertools
import threading

from . import assets


class AdapterError(Exception):
    pass


class MockCamera:
    """模拟拍摄亭相机。

    mode:
      normal  -> 正常片，变体按订单/轮次确定性轮换
      blink   -> 强制返回眨眼片（用于眨眼重拍路径）
    设备离线由服务层根据 devices.status 判定，适配器本身不判定。
    """

    def __init__(self):
        self._lock = threading.Lock()
        self._counter = itertools.count(1)
        self.mode = "normal"

    def set_mode(self, mode):
        assert mode in ("normal", "blink")
        self.mode = mode

    def capture(self, order_id, round_no):
        with self._lock:
            seq = next(self._counter)
        variant = ((order_id * 7 + round_no * 3 + seq) % len(assets.VARIANTS)) + 1
        blink = self.mode == "blink"
        src = f"person_{variant}{'_blink' if blink else ''}.svg"
        return {
            "ok": True,
            "src_file": src,
            "variant": variant,
            "blink": blink,
            "seq": seq,
        }


class MockPrinter:
    """模拟冲印机。缺纸/卡纸由服务层结合 devices.status 与 paper 判定。

    set_jammed(device_id) 可模拟打印中途失败，供后台重试路径使用。
    """

    def __init__(self):
        self.jammed = set()
        self._lock = threading.Lock()

    def set_jammed(self, device_id, on=True):
        with self._lock:
            if on:
                self.jammed.add(device_id)
            else:
                self.jammed.discard(device_id)

    def print(self, device, copies, out_file):
        with self._lock:
            if device["id"] in self.jammed:
                return {"ok": False, "error": "打印机卡纸（模拟）", "consumed": 0}
            if device["status"] == "offline":
                return {"ok": False, "error": "打印设备离线", "consumed": 0}
            if device["paper"] < copies:
                return {"ok": False, "error": "打印缺纸", "consumed": 0}
        return {"ok": True, "consumed": copies, "error": None}


class MockPayment:
    """模拟付款通道：付款成功返回回执号；退款按回执号退款。

    fail_next_refund 用于模拟通道瞬时失败（退款幂等重试时不应重复打款——
    幂等由服务层 refunds.idempotency_key 保证）。
    """

    def __init__(self):
        self._lock = threading.Lock()
        self._seq = itertools.count(1000)
        self.refunded_receipts = set()
        self.fail_next_refund = False

    def pay(self, amount):
        with self._lock:
            no = f"PAY-{next(self._seq)}"
        return {"ok": True, "receipt_no": no, "amount": amount}

    def refund(self, receipt_no, amount):
        with self._lock:
            fail = self.fail_next_refund
            self.fail_next_refund = False
            if fail:
                return {"ok": False, "error": "支付通道超时，请稍后重试", "receipt_no": receipt_no}
            if receipt_no in self.refunded_receipts:
                # 通道侧防重：同一付款回执只退一次
                return {"ok": False, "error": "该回执已退款", "receipt_no": receipt_no, "dup": True}
            self.refunded_receipts.add(receipt_no)
        return {"ok": True, "receipt_no": receipt_no, "amount": amount}


camera = MockCamera()
printer = MockPrinter()
payment = MockPayment()
