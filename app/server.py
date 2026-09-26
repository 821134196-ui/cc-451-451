"""HTTP 服务：标准库实现，零第三方依赖。

页面：/                     首页（叫号开单 + 导航）
      /screen/call          叫号屏
      /screen/capture       拍摄终端
      /screen/select        候选选择
      /screen/preview       规格预览
      /screen/retouch       修正队列（修图人员）
      /screen/print         冲印任务
      /screen/pickup        取件核验
      /screen/refund        退款复核（店长）
"""
import json
import os
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

from . import assets, config, service
from .database import get_conn, init_db
from .service import ServiceError
from .worker import worker

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
PAGES_DIR = os.path.join(BASE_DIR, "pages")

MIME = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
}


class Handler(BaseHTTPRequestHandler):
    server_version = "IDPhoto/1.0"

    # ------------------------------------------------------------ helpers
    def _send(self, code, body, ctype="application/json; charset=utf-8"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False).encode()
        elif isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _json_body(self):
        n = int(self.headers.get("Content-Length", 0))
        if not n:
            return {}
        raw = self.rfile.read(n)
        try:
            return json.loads(raw.decode())
        except json.JSONDecodeError:
            raise ServiceError("bad_json", "请求体不是合法 JSON")

    def _ok(self, data):
        self._send(200, {"ok": True, "data": data})

    def _err(self, exc):
        self._send(400, {"ok": False, "code": exc.code, "error": exc.message})

    def _file(self, path, ctype=None):
        if not os.path.isfile(path):
            self._send(404, {"ok": False, "error": "not found"})
            return
        ext = os.path.splitext(path)[1]
        with open(path, "rb") as f:
            self._send(200, f.read(), ctype or MIME.get(ext, "application/octet-stream"))

    def log_message(self, fmt, *args):
        pass  # 静默；演示时可改 print

    # ------------------------------------------------------------ GET
    def do_GET(self):
        u = urlparse(self.path)
        p, q = u.path, parse_qs(u.query)
        try:
            if p == "/" or p == "/index.html":
                return self._file(os.path.join(PAGES_DIR, "index.html"))
            m = re.fullmatch(r"/screen/(\w+)", p)
            if m:
                return self._file(os.path.join(PAGES_DIR, f"{m.group(1)}.html"))
            if p.startswith("/static/"):
                return self._file(os.path.join(STATIC_DIR, p[len("/static/"):]))
            if p.startswith("/placeholders/"):
                return self._file(os.path.join(config.PLACEHOLDER_DIR, os.path.basename(p)))
            if p.startswith("/outputs/"):
                return self._file(os.path.join(config.OUTPUT_DIR, os.path.basename(p)))
            if p == "/api/specs":
                return self._ok(config.SPECS)
            if p == "/api/devices":
                return self._ok(service.list_devices(q.get("kind", [None])[0]))
            if p == "/api/orders/resolve":
                q = q.get("q", [""])[0].strip()
                if q.isdigit():
                    return self._ok(service.get_order(int(q)))
                return self._ok(service.find_order_by_queue(q))
            if p == "/api/orders":
                return self._ok(service.list_orders(q.get("status", [None])[0]))
            if p == "/api/call-board":
                return self._ok(self._call_board())
            m = re.fullmatch(r"/api/orders/(\d+)", p)
            if m:
                return self._ok(self._order_detail(int(m.group(1))))
            m = re.fullmatch(r"/api/orders/(\d+)/candidates", p)
            if m:
                return self._ok(service.list_candidates(int(m.group(1))))
            m = re.fullmatch(r"/api/orders/(\d+)/preview", p)
            if m:
                return self._ok(service.spec_preview(int(m.group(1))))
            m = re.fullmatch(r"/api/orders/(\d+)/pickup-code", p)
            if m:
                return self._ok(service.get_active_pickup_code(int(m.group(1))))
            if p == "/api/retouch/queue":
                return self._ok(service.list_retouch_queue())
            m = re.fullmatch(r"/api/retouch/orders/(\d+)", p)
            if m:
                who = q.get("retoucher", ["anonymous"])[0]
                return self._ok(service.order_dto_for_retoucher(int(m.group(1)), who))
            if p == "/api/prints":
                return self._ok(service.list_print_jobs(q.get("status", [None])[0]))
            if p == "/api/refunds":
                return self._ok(service.list_refunds(q.get("status", [None])[0]))
            self._send(404, {"ok": False, "error": "not found"})
        except ServiceError as e:
            self._err(e)

    def _call_board(self):
        conn = get_conn()
        current = [dict(r) for r in conn.execute(
            """SELECT o.queue_no, o.customer_name, o.spec_key, o.device_id, o.status, d.name device_name
               FROM orders o LEFT JOIN devices d ON d.id=o.device_id
               WHERE o.status IN ('queued','selected','retouching','printing')
               ORDER BY o.id""")]
        recent = [dict(r) for r in conn.execute(
            "SELECT queue_no, status FROM orders WHERE status IN ('completed','picked') ORDER BY id DESC LIMIT 5")]
        cameras = service.list_devices("camera")
        return {"current": current, "recent": recent, "cameras": cameras}

    def _order_detail(self, oid):
        o = service.get_order(oid)
        o["candidates"] = service.list_candidates(oid)
        conn = get_conn()
        o["print_jobs"] = [dict(r) for r in conn.execute(
            "SELECT * FROM print_jobs WHERE order_id=? ORDER BY id", (oid,))]
        pc = service.get_active_pickup_code(oid)
        o["pickup_code"] = pc["code"] if pc else None
        o["pickup_expires_at"] = pc["expires_at"] if pc else None
        if o["selected_photo_id"]:
            o["selected_photo"] = service.get_photo(o["selected_photo_id"])
        return o

    # ------------------------------------------------------------ POST
    def do_POST(self):
        p = urlparse(self.path).path
        body = {}
        try:
            body = self._json_body()
            if p == "/api/call":
                o = service.call_next(
                    body["customer_name"], body["spec_key"], body["device_id"],
                    int(body.get("copies", 1)), bool(body.get("retouch_required", False)))
                return self._ok(o)
            m = re.fullmatch(r"/api/devices/([\w-]+)/status", p)
            if m:
                return self._ok(service.set_device_status(m.group(1), body["status"]))
            m = re.fullmatch(r"/api/devices/([\w-]+)/paper", p)
            if m:
                return self._ok(service.add_paper(m.group(1), int(body.get("n", 0))))
            m = re.fullmatch(r"/api/orders/(\d+)/capture", p)
            if m:
                return self._ok(service.capture(int(m.group(1))))
            m = re.fullmatch(r"/api/orders/(\d+)/confirm", p)
            if m:
                return self._ok(service.confirm_selection(
                    int(m.group(1)), int(body["photo_id"]), body.get("crop"),
                    body.get("client_token")))
            m = re.fullmatch(r"/api/orders/(\d+)/reopen", p)
            if m:
                return self._ok(service.reopen_selection(
                    int(m.group(1)), body.get("staff", "店员"), body.get("reason", "")))
            m = re.fullmatch(r"/api/orders/(\d+)/retouch", p)
            if m:
                return self._ok(service.submit_retouch(
                    int(m.group(1)), body.get("retoucher", "修图员"), body.get("note", "")))
            m = re.fullmatch(r"/api/orders/(\d+)/reprint", p)
            if m:
                return self._ok(service.add_reprint(
                    int(m.group(1)), int(body.get("copies", 1)), body.get("staff", "店员")))
            m = re.fullmatch(r"/api/orders/(\d+)/reissue", p)
            if m:
                return self._ok({"code": service.reissue_pickup_code(
                    int(m.group(1)), body.get("staff", "店员"))})
            if p == "/api/prints/run":
                return self._ok(service.process_print_job(
                    int(body["job_id"]), body.get("device_id")))
            if p == "/api/pickup/verify":
                return self._ok(service.verify_pickup(str(body.get("code", "")).zfill(6)))
            if p == "/api/refunds":
                key = body.get("idem_key") or f"o{body['order_id']}-{body['amount']}-{body.get('requested_by','x')}"
                return self._ok(service.request_refund(
                    int(body["order_id"]), int(body["amount"]),
                    body.get("reason", ""), body.get("requested_by", "店员"), key))
            m = re.fullmatch(r"/api/refunds/(\d+)/review", p)
            if m:
                return self._ok(service.review_refund(
                    int(m.group(1)), body.get("manager", ""), bool(body.get("approve"))))
            if p == "/api/worker/tick":
                return self._ok(worker.tick_once())
            if p == "/api/camera/mode":
                from .adapters import camera
                camera.set_mode(body.get("mode", "normal"))
                return self._ok({"mode": camera.mode})
            m = re.fullmatch(r"/api/printers/([\w-]+)/jam", p)
            if m:
                from .adapters import printer
                printer.set_jammed(m.group(1), bool(body.get("on", True)))
                return self._ok({"device": m.group(1), "jammed": body.get("on", True)})
            self._send(404, {"ok": False, "error": "not found"})
        except ServiceError as e:
            self._err(e)


def serve(host="127.0.0.1", port=8000):
    worker.start()
    srv = ThreadingHTTPServer((host, port), Handler)
    print(f"自助证件照系统已启动: http://{host}:{port}")
    print("页面: 叫号屏 /screen/call · 拍摄 /screen/capture · 选片 /screen/select · "
          "规格预览 /screen/preview")
    print("      修正 /screen/retouch · 冲印 /screen/print · 取件 /screen/pickup · 退款 /screen/refund")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        worker.stop()
        srv.shutdown()


if __name__ == "__main__":
    config.ensure_dirs()
    init_db(seed=True)
    assets.generate_all()
    serve()
