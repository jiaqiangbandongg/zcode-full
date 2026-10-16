"""
xlsx skill — Palette System (Style-First Theme Engine)
=======================================================
12 visual styles × scene-based fallback. No domain-color binding.

Themes (12):
  professional, warm, elegant, creative,
  muji, aesop, kinfolk, celine, bottega, chanel, bloomberg, original_blue

Matching priority:
  1. Explicit style keywords in prompt → direct match
  2. Scene/content keywords → infer style
  3. No match → professional (safe default)

Usage:
    from templates.palettes import resolve_palette, get_palette

    # Auto-detect from user prompt
    palette = resolve_palette("帮我做一个温暖的销售月报")  # Chinese prompt example
    # → warm palette

    # Manual selection
    palette = get_palette("bottega")
"""

from __future__ import annotations
from typing import Dict, Optional, Tuple

# ============================================================
# §1  Palette Data Structure
# ============================================================

_Palette = Dict[str, str | list]


def _make_palette(
    *,
    primary: str,
    primary_light: str,
    accent_positive: str = "1B7D46",
    accent_negative: str = "C0392B",
    accent_warning: str = "D4820A",
    neutral_900: str = "37352F",
    neutral_600: str = "8C8A84",
    neutral_200: str = "E9E9E8",
    neutral_100: str = "F7F7F5",
    neutral_50: str = "FAFAF9",
    neutral_0: str = "FFFFFF",
    header_text: str = "FFFFFF",
    cf_positive_bg: str = "E8F5E9",
    cf_negative_bg: str = "FDEDEC",
    cf_warning_bg: str = "FEF9E7",
) -> _Palette:
    return {
        "PRIMARY": primary,
        "PRIMARY_LIGHT": primary_light,
        "SECONDARY": primary_light,
        "ACCENT_POSITIVE": accent_positive,
        "ACCENT_NEGATIVE": accent_negative,
        "ACCENT_WARNING": accent_warning,
        "NEUTRAL_900": neutral_900,
        "NEUTRAL_600": neutral_600,
        "NEUTRAL_200": neutral_200,
        "NEUTRAL_100": neutral_100,
        "NEUTRAL_50": neutral_50,
        "NEUTRAL_0": neutral_0,
        "HEADER_TEXT": header_text,
        "CF_POSITIVE_BG": cf_positive_bg,
        "CF_NEGATIVE_BG": cf_negative_bg,
        "CF_WARNING_BG": cf_warning_bg,
        "CHART_COLORS": [primary, accent_positive, accent_warning, accent_negative, neutral_600],
    }


# ============================================================
# §2  Legacy Palettes (6 original styles)
# ============================================================

# -- Professional: formal business, universal default --
PROFESSIONAL = _make_palette(
    primary="1B2A4A",
    primary_light="D6E4F0",
)

# -- Warm: warm and vibrant, high impact --
WARM = _make_palette(
    primary="B85C1E",
    primary_light="F5E6D5",
    accent_positive="2E7D32",
    accent_negative="C62828",
    accent_warning="E65100",
    neutral_900="3E2F1F",
    neutral_600="9C8B78",
    neutral_200="EAE0D5",
    neutral_100="F7F2EC",
    neutral_50="FBF8F5",
)

# -- Fresh: natural freshness, friendly and light --
FRESH = _make_palette(
    primary="0E7C6B",
    primary_light="D4F0EB",
    accent_positive="2E9E5A",
    accent_negative="D94F4F",
    accent_warning="E6A023",
    neutral_900="2F3735",
    neutral_600="7A8C87",
    neutral_200="DEE9E6",
    neutral_100="F2F8F6",
    neutral_50="F8FBFA",
)

# -- Elegant: premium restraint, minimalist black-white --
ELEGANT = _make_palette(
    primary="2C2C2C",
    primary_light="E5E5E5",
    accent_positive="4A4A4A",
    accent_negative="8B0000",
    accent_warning="6B6B6B",
    neutral_900="1A1A1A",
    neutral_600="808080",
    neutral_200="D4D4D4",
    neutral_100="F0F0F0",
    neutral_50="F8F8F8",
)

# -- Creative: artistic personality, distinctive --
CREATIVE = _make_palette(
    primary="6C5B7B",
    primary_light="E4DDE8",
    accent_positive="6B9E78",
    accent_negative="C06C7E",
    accent_warning="C4A46A",
    neutral_900="3E3A42",
    neutral_600="9590A0",
    neutral_200="E0DCE4",
    neutral_100="F3F1F5",
    neutral_50="F9F8FA",
)

# -- Vibrant: high-saturation multi-color, data display --
VIBRANT = _make_palette(
    primary="2563EB",
    primary_light="DBEAFE",
    accent_positive="16A34A",
    accent_negative="DC2626",
    accent_warning="EA580C",
    neutral_900="1E293B",
    neutral_600="64748B",
    neutral_200="E2E8F0",
    neutral_100="F1F5F9",
    neutral_50="F8FAFC",
)


# ============================================================
# §3  Premium Palettes (8 curated themes, "high-end feel" series)
# ============================================================

# -- A · MUJI breathing feel: restrained minimalism, pencil on paper --
MUJI = _make_palette(
    primary="2C2C2C",
    primary_light="F2F1EE",
    accent_positive="5B8C5A",
    accent_negative="C25450",
    accent_warning="C9A84C",
    neutral_900="2C2C2C",
    neutral_600="999999",
    neutral_200="E8E6E1",
    neutral_100="F9F9F7",
    neutral_50="FCFCFB",
    header_text="FFFFFF",
)

# -- B · Aesop sandstone: earth tones, premium skincare packaging --
AESOP = _make_palette(
    primary="3D3229",
    primary_light="EDE8E0",
    accent_positive="6B8F71",
    accent_negative="B85C4A",
    accent_warning="C4975A",
    neutral_900="4A4038",
    neutral_600="8C7B6B",
    neutral_200="DDD5C9",
    neutral_100="FAF8F5",
    neutral_50="FDFCFA",
    header_text="FFFFFF",
)

# -- C · Dieter Rams Industrial: Less but better --
DIETER_RAMS = _make_palette(
    primary="1A1A1A",
    primary_light="F7F7F7",
    accent_positive="2D8C6F",
    accent_negative="D44D3C",
    accent_warning="D4920A",
    neutral_900="1A1A1A",
    neutral_600="787878",
    neutral_200="E5E5E5",
    neutral_100="F7F7F7",
    neutral_50="FAFAFA",
    header_text="FFFFFF",
)

# -- D · Kinfolk cream publication: independent magazine typography, slow-life aesthetic --
KINFOLK = _make_palette(
    primary="5C524C",
    primary_light="F0ECE7",
    accent_positive="8DAA7F",
    accent_negative="C9776A",
    accent_warning="C9A96A",
    neutral_900="5C524C",
    neutral_600="BEB5AD",
    neutral_200="EAE5DF",
    neutral_100="FDFCFA",
    neutral_50="FEFDFB",
    header_text="FFFFFF",
)

# -- E · Céline pure black-white: monochrome, fashion house coldness --
CELINE = _make_palette(
    primary="000000",
    primary_light="FAFAFA",
    accent_positive="4A7C59",
    accent_negative="A63D2F",
    accent_warning="8C7A3C",
    neutral_900="000000",
    neutral_600="ADADAD",
    neutral_200="E0E0E0",
    neutral_100="FAFAFA",
    neutral_50="FDFDFD",
    header_text="FFFFFF",
)

# -- F · Bottega dark green: Italian luxury, deep forest green --
BOTTEGA = _make_palette(
    primary="2D4A3E",
    primary_light="E8F0EB",
    accent_positive="5FA67A",
    accent_negative="C2694B",
    accent_warning="B89B4A",
    neutral_900="3B5249",
    neutral_600="7A9B8C",
    neutral_200="D4E3DB",
    neutral_100="F6FAF8",
    neutral_50="F9FCFA",
    header_text="FFFFFF",
)

# -- G · Chanel champagne gold: Chanel elegance, beige + golden brown --
CHANEL = _make_palette(
    primary="1C1917",
    primary_light="E7DFD4",
    accent_positive="A3845B",
    accent_negative="B0413E",
    accent_warning="C4975A",
    neutral_900="1C1917",
    neutral_600="A39888",
    neutral_200="E7E0D5",
    neutral_100="FDFBF7",
    neutral_50="FEFDFB",
    header_text="FFFFFF",
)

# -- H · Bloomberg deep blue: financial terminal, high-density data aesthetic --
BLOOMBERG = _make_palette(
    primary="0D1B2A",
    primary_light="D6E0EB",
    accent_positive="10B981",
    accent_negative="EF4444",
    accent_warning="F59E0B",
    neutral_900="0D1B2A",
    neutral_600="708DA8",
    neutral_200="D6E0EB",
    neutral_100="F4F7FA",
    neutral_50="F8FAFB",
    header_text="FFFFFF",
)

# -- Original Blue/Black: original blue-black color scheme (Round 1 #1/#6 style) --
ORIGINAL_BLUE = _make_palette(
    primary="1B2A4A",
    primary_light="D6E4F0",
    accent_positive="2E8B57",
    accent_negative="EB5757",
    accent_warning="F2994A",
    neutral_900="333333",
    neutral_600="666666",
    neutral_200="E0E0E0",
    neutral_100="F5F5F5",
    neutral_50="FAFAFA",
)


# ============================================================
# §4  Registry
# ============================================================

PALETTE_REGISTRY: Dict[str, _Palette] = {
    # Legacy (removed: fresh, vibrant)
    "professional": PROFESSIONAL,
    "warm": WARM,
    "elegant": ELEGANT,
    "creative": CREATIVE,
    # Premium (high-end feel)
    "muji": MUJI,
    "aesop": AESOP,
    # dieter_rams removed — header too dark, poor readability
    "kinfolk": KINFOLK,
    "celine": CELINE,
    "bottega": BOTTEGA,
    "chanel": CHANEL,
    "bloomberg": BLOOMBERG,
    "original_blue": ORIGINAL_BLUE,
}

# Aliases for convenience
PALETTE_REGISTRY["muji_breathing"] = MUJI
PALETTE_REGISTRY["sandstone"] = AESOP
PALETTE_REGISTRY["industrial"] = BLOOMBERG  # was dieter_rams, redirected
PALETTE_REGISTRY["cream"] = KINFOLK
PALETTE_REGISTRY["monochrome"] = CELINE
PALETTE_REGISTRY["forest_green"] = BOTTEGA
PALETTE_REGISTRY["champagne"] = CHANEL
PALETTE_REGISTRY["terminal"] = BLOOMBERG
PALETTE_REGISTRY["classic_blue"] = ORIGINAL_BLUE


# ============================================================
# §5  Keyword Matching (three-step)
# ============================================================

# Step 1: Explicit style keywords (highest priority)
_STYLE_KEYWORDS: Dict[str, list[str]] = {
    "professional": [
        "正式", "商务", "专业", "沉稳", "稳重", "professional", "formal",
        "corporate", "business",
    ],
    "warm": [
        "温暖", "活力", "热情", "热烈", "暖色", "温馨", "warm", "energetic",
        "活跃", "热力",
    ],
    "elegant": [
        "极简", "简约", "elegant", "minimal",
        "清新", "自然", "清爽", "淡雅", "浅色", "明亮", "fresh",
        "natural", "clean", "light", "素雅",
        "多彩", "丰富", "鲜艳", "vivid", "colorful", "明快",
        "高饱和", "鲜明", "亮色",
    ],
    "creative": [
        "文艺", "个性", "紫色", "莫兰迪", "creative", "artistic",
        "柔和", "雅致",
    ],
    # Premium themes
    "muji": [
        "muji", "无印", "呼吸感", "白纸", "铅笔", "素净", "无印良品",
    ],
    "aesop": [
        "aesop", "沙岩", "大地色", "护肤", "泥土", "陶", "terracotta",
    ],
    "bloomberg": [
        "bloomberg", "终端", "深蓝", "terminal", "金融终端", "数据终端",
        "rams", "dieter", "工业", "德系", "包豪斯", "bauhaus", "less but better",
        "工业风",
    ],
    "kinfolk": [
        "kinfolk", "奶油", "刊物", "杂志", "慢生活", "latte", "拿铁",
    ],
    "celine": [
        "celine", "黑白", "时装", "冷冽", "mono", "纯黑", "monochrome",
    ],
    "bottega": [
        "bottega", "墨绿", "深绿", "森林", "橄榄", "绿色", "forest",
        "贵气", "奢牌",
    ],
    "chanel": [
        "chanel", "米金", "金棕", "香奈儿", "champagne", "米色", "奶茶",
    ],
    "original_blue": [
        "原始", "经典蓝", "classic blue", "original", "传统蓝",
    ],
}

# Step 2: Scene keywords → infer style (lower priority)
_SCENE_TO_STYLE: Dict[str, str] = {
    # Sales / Marketing / Ops → warm
    "销售": "warm", "营销": "warm", "运营": "warm", "客户": "warm",
    "业绩": "warm", "KPI": "warm", "GMV": "warm", "转化": "warm",
    "漏斗": "warm", "签约": "warm", "提成": "warm", "电商": "warm",
    "sales": "warm", "marketing": "warm", "campaign": "warm",
    # Education / Medical → muji (was fresh, now removed)
    "成绩": "muji", "考试": "muji", "学生": "muji", "课程": "muji",
    "教育": "muji", "GPA": "muji", "学校": "muji", "班级": "muji",
    "医疗": "muji", "健康": "muji", "患者": "muji", "体检": "muji",
    "医院": "muji", "科室": "muji", "护理": "muji",
    "环保": "muji",
    "education": "muji", "medical": "muji", "health": "muji",
    # Design / Brand → creative
    "设计": "creative", "创意": "creative", "品牌": "creative",
    "UI": "creative", "UX": "creative", "作品": "creative",
    "视觉": "creative", "素材": "creative",
    "design": "creative", "brand": "creative", "portfolio": "creative",
    # Formal / Reporting → professional
    "汇报": "professional", "提案": "professional", "会议": "professional",
    "述职": "professional", "总结": "professional", "报告": "professional",
    "年报": "professional", "季报": "professional", "月报": "professional",
    "财务": "professional", "财报": "professional", "预算": "professional",
    "审计": "professional", "咨询": "professional", "战略": "professional",
    "finance": "professional", "budget": "professional", "report": "professional",
    # Minimal / Premium → elegant
    "premium": "elegant", "luxury": "elegant",
    # Finance data → bloomberg
    "股票": "bloomberg", "基金": "bloomberg", "投资": "bloomberg",
    "交易": "bloomberg", "行情": "bloomberg", "K线": "bloomberg",
    "stock": "bloomberg", "trading": "bloomberg", "portfolio_fin": "bloomberg",
    # High-end / Luxury brand → chanel
    "奢侈": "chanel", "高端": "chanel", "高级": "chanel",
}


def _match_style_keywords(text: str) -> Optional[str]:
    """Step 1: Match explicit style keywords. Returns style name or None."""
    text_lower = text.lower()
    best_match = None
    best_score = 0
    for style, keywords in _STYLE_KEYWORDS.items():
        score = sum(1 for kw in keywords if kw.lower() in text_lower)
        if score > best_score:
            best_score = score
            best_match = style
    return best_match if best_score > 0 else None


def _infer_from_scene(text: str) -> Optional[str]:
    """Step 2: Infer style from scene/content keywords. Returns style name or None."""
    text_lower = text.lower()
    votes: Dict[str, int] = {}
    for keyword, style in _SCENE_TO_STYLE.items():
        if keyword.lower() in text_lower:
            votes[style] = votes.get(style, 0) + 1
    if not votes:
        return None
    return max(votes, key=votes.get)


# ============================================================
# §6  Public API
# ============================================================

def get_palette(style: str = "professional") -> _Palette:
    """Get a palette by style name. Falls back to professional."""
    return PALETTE_REGISTRY.get(style, PROFESSIONAL)


def resolve_palette(prompt: str) -> _Palette:
    """
    Auto-detect style from user prompt (three-step):
      1. Explicit style keywords → direct match
      2. Scene/content keywords → infer style
      3. No match → professional (safe default)
    """
    style = detect_style(prompt)
    return get_palette(style)


def resolve_palette_with_info(prompt: str) -> Tuple[_Palette, str]:
    """Same as resolve_palette but also returns the detected style name."""
    style = detect_style(prompt)
    return get_palette(style), style


def detect_style(prompt: str) -> str:
    """
    Detect style from prompt. Three-step priority:
      1. Explicit style keywords
      2. Scene keywords → infer style
      3. Default: professional
    """
    style = _match_style_keywords(prompt)
    if style:
        return style
    style = _infer_from_scene(prompt)
    if style:
        return style
    return "professional"


def list_available() -> list[str]:
    """Return list of available style names (no aliases)."""
    # Return only canonical names, not aliases
    canonical = [
        "professional", "warm", "elegant", "creative",
        "muji", "aesop", "kinfolk", "celine", "bottega",
        "chanel", "bloomberg", "original_blue",
    ]
    return canonical


def apply_palette(palette: _Palette, module_globals: dict):
    """
    Inject palette tokens into a module's global namespace.
    Designed to be called from base.py to override its color constants.
    """
    key_map = {
        "PRIMARY": "PRIMARY",
        "PRIMARY_LIGHT": "PRIMARY_LIGHT",
        "SECONDARY": "SECONDARY",
        "ACCENT_POSITIVE": "ACCENT_POSITIVE",
        "ACCENT_NEGATIVE": "ACCENT_NEGATIVE",
        "ACCENT_WARNING": "ACCENT_WARNING",
        "NEUTRAL_900": "NEUTRAL_900",
        "NEUTRAL_600": "NEUTRAL_600",
        "NEUTRAL_200": "NEUTRAL_200",
        "NEUTRAL_100": "NEUTRAL_100",
        "NEUTRAL_50": "NEUTRAL_50",
        "NEUTRAL_0": "NEUTRAL_0",
        "CHART_COLORS": "CHART_COLORS",
    }
    for palette_key, global_key in key_map.items():
        if palette_key in palette:
            module_globals[global_key] = palette[palette_key]
