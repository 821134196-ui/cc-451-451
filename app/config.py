"""全局配置：路径、规格表、业务常量。"""
import os

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.environ.get("IDPHOTO_DATA", os.path.join(BASE_DIR, "data"))
DB_PATH = os.environ.get("IDPHOTO_DB", os.path.join(DATA_DIR, "idphoto.db"))
PLACEHOLDER_DIR = os.path.join(DATA_DIR, "placeholders")
OUTPUT_DIR = os.path.join(DATA_DIR, "outputs")

# ---- 业务常量 ----
MAX_ROUNDS = 3            # 单次订单最多拍摄轮次（重拍次数）
PICKUP_CODE_TTL = 86400   # 取件码有效期（秒）：24 小时
PRINT_MAX_RETRY = 3       # 打印失败最大重试次数
RETRY_INTERVAL = 5        # 后台打印重试间隔（秒）
TICK_INTERVAL = 2         # 后台任务轮询间隔（秒）

# ---- 证件规格（毫米） ----
# px = mm / 25.4 * dpi，300dpi 用于裁切校验与预览
SPECS = {
    "one_inch": {
        "name": "一寸照",
        "mm_w": 25, "mm_h": 35,
        "dpi": 300,
        "head_mm_min": 21, "head_mm_max": 26,
        "head_top_mm_min": 3, "head_top_mm_max": 7,
    },
    "two_inch": {
        "name": "二寸照",
        "mm_w": 35, "mm_h": 49,
        "dpi": 300,
        "head_mm_min": 30, "head_mm_max": 36,
        "head_top_mm_min": 4, "head_top_mm_max": 9,
    },
    "id_card": {
        "name": "身份证",
        "mm_w": 26, "mm_h": 32,
        "dpi": 350,
        "head_mm_min": 19, "head_mm_max": 24,
        "head_top_mm_min": 3, "head_top_mm_max": 7,
    },
    "passport": {
        "name": "护照",
        "mm_w": 33, "mm_h": 48,
        "dpi": 300,
        "head_mm_min": 28, "head_mm_max": 34,
        "head_top_mm_min": 4, "head_top_mm_max": 9,
    },
}

# 相机原始占位图尺寸（px），所有候选同尺寸，满足任何规格的裁切需求
RAW_W, RAW_H = 1200, 1600

# ---- 配色（页面：中性白 / 石墨黑 / 证件蓝） ----
COLOR_WHITE = "#F5F6F8"
COLOR_GRAPHITE = "#22262B"
COLOR_BLUE = "#1F4E8C"


def mm_to_px(mm, dpi):
    return round(mm / 25.4 * dpi)


def ensure_dirs():
    os.makedirs(PLACEHOLDER_DIR, exist_ok=True)
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    os.makedirs(DATA_DIR, exist_ok=True)
