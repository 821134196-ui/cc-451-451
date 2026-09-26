"""预置占位素材：在 placeholders/ 下生成 SVG 人像占位图。

不使用真实人像。每个变体带人脸测量元数据（原始 1200x1600 坐标系），
供规格校验（头部高度、头顶留白）使用。
"""
import os

from . import config

# face: (head_top, head_height) 原始像素坐标中的头顶 y 与头部高度
VARIANTS = {
    1: {"tone": "#E8C9A0", "suit": "#3A4456", "head_top": 300, "head_h": 560},
    2: {"tone": "#D9A97C", "suit": "#2F3B4C", "head_top": 310, "head_h": 540},
    3: {"tone": "#F0D4B4", "suit": "#455063", "head_top": 290, "head_h": 580},
    4: {"tone": "#C99A6E", "suit": "#333D4D", "head_top": 305, "head_h": 520},
    # 头部过大、顶距过小的变体，用于触发“规格不符”
    5: {"tone": "#E3BE95", "suit": "#3B4658", "head_top": 190, "head_h": 740},
    6: {"tone": "#D3A477", "suit": "#2C3747", "head_top": 300, "head_h": 555},
}


def person_svg(variant, blink=False):
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="{config.RAW_W}" height="{config.RAW_H}" viewBox="0 0 1200 1600">
{person_inner(variant, blink)}
</svg>'''


def person_inner(variant, blink=False):
    """人像的内部元素，供完整图与内嵌裁切图复用。"""
    v = VARIANTS[variant]
    eyes = []
    if blink:
        eyes.append('<line x1="470" y1="560" x2="540" y2="560" stroke="#22262B" stroke-width="10" stroke-linecap="round"/>')
        eyes.append('<line x1="660" y1="560" x2="730" y2="560" stroke="#22262B" stroke-width="10" stroke-linecap="round"/>')
    else:
        eyes.append('<ellipse cx="505" cy="555" rx="30" ry="18" fill="#FFFFFF"/>')
        eyes.append('<ellipse cx="695" cy="555" rx="30" ry="18" fill="#FFFFFF"/>')
        eyes.append('<circle cx="505" cy="558" r="11" fill="#22262B"/>')
        eyes.append('<circle cx="695" cy="558" r="11" fill="#22262B"/>')
    tag = "眨眼" if blink else "占位素材"
    return f'''  <rect width="1200" height="1600" fill="#E9EDF2"/>
  <rect x="0" y="1250" width="1200" height="350" fill="{v['suit']}"/>
  <ellipse cx="600" cy="1330" rx="180" ry="70" fill="{v['tone']}"/>
  <rect x="540" y="1180" width="120" height="170" fill="{v['tone']}"/>
  <ellipse cx="600" cy="640" rx="215" ry="275" fill="{v['tone']}"/>
  <path d="M380 520 Q600 300 820 520 Q820 420 600 400 Q380 420 380 520 Z" fill="#2B2F36"/>
  {''.join(eyes)}
  <path d="M540 720 Q600 760 660 720" stroke="#8A5A44" stroke-width="8" fill="none" stroke-linecap="round"/>
  <text x="40" y="1560" font-family="sans-serif" font-size="40" fill="#FFFFFF" opacity="0.85">{tag} P{variant} · 1200×1600</text>'''


def cropped_svg(variant, blink, crop, label, border=False):
    """生成自包含的裁切 SVG（内嵌人像，<img> 引用时无需外部资源）。"""
    x, y, w, h = crop
    border_rect = ('<rect x="6" y="6" width="%d" height="%d" fill="none" stroke="#1F4E8C" stroke-width="12"/>'
                   % (w - 12, h - 12)) if border else ""
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}">
  <svg x="{-x}" y="{-y}" width="{config.RAW_W}" height="{config.RAW_H}">
{person_inner(variant, blink)}
  </svg>
  {border_rect}
  <text x="16" y="{h - 18}" font-family="sans-serif" font-size="28" fill="#FFFFFF" opacity="0.95">{label}</text>
</svg>'''


def generate_all():
    config.ensure_dirs()
    created = []
    for variant in VARIANTS:
        for blink in (False, True):
            name = f"person_{variant}{'_blink' if blink else ''}.svg"
            path = os.path.join(config.PLACEHOLDER_DIR, name)
            if not os.path.exists(path):
                with open(path, "w", encoding="utf-8") as f:
                    f.write(person_svg(variant, blink))
            created.append(name)
    return created


def face_meta(variant):
    v = VARIANTS[variant]
    return v["head_top"], v["head_h"]


def variant_from_file(src_file):
    base = os.path.basename(src_file)
    return int(base.split("_")[1].split(".")[0])
