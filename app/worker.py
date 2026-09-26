"""进程内后台任务：取件码到期扫描、打印失败重试。"""
import threading
import time

from . import config, service


class BackgroundWorker:
    def __init__(self, interval=config.TICK_INTERVAL):
        self.interval = interval
        self._stop = threading.Event()
        self._thread = None
        self.last_print_retry = 0.0
        self.stats = {"pickup_expired": 0, "print_retries": 0}

    def start(self):
        if self._thread and self._thread.is_alive():
            return
        self._thread = threading.Thread(target=self._run, name="idphoto-worker", daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()

    def tick_once(self):
        n = service.expire_pickup_codes()
        self.stats["pickup_expired"] += n
        now = time.monotonic()
        if now - self.last_print_retry >= config.RETRY_INTERVAL:
            self.last_print_retry = now
            results = service.retry_due_prints()
            self.stats["print_retries"] += len(results)
            return {"expired": n, "print_results": results}
        return {"expired": n, "print_results": []}

    def _run(self):
        while not self._stop.wait(self.interval):
            try:
                self.tick_once()
            except Exception as e:  # 后台任务不能因单次异常退出
                print(f"[worker] tick error: {e}")


worker = BackgroundWorker()
