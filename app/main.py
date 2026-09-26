"""入口：python -m app.main"""
import argparse

from . import assets, config
from .database import init_db
from .server import serve
from .worker import worker


def main():
    ap = argparse.ArgumentParser(description="自助证件照门店拍摄重选与取件系统")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--init-only", action="store_true", help="仅初始化数据库与占位素材后退出")
    args = ap.parse_args()

    config.ensure_dirs()
    init_db(seed=True)
    assets.generate_all()
    print(f"初始化完成：数据库 {config.DB_PATH}")
    print(f"占位素材目录：{config.PLACEHOLDER_DIR}；输出目录：{config.OUTPUT_DIR}")
    if args.init_only:
        return
    serve(args.host, args.port)


if __name__ == "__main__":
    main()
