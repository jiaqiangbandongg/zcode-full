#!/usr/bin/env bash
# Lightweight environment check for PDF skill.
# Exit 0 = all CORE deps OK, exit 1 = missing CORE dependency.
# Playwright/Chromium (Creative/HTML pipeline) and Tectonic (Academic/LaTeX) are
# OPTIONAL — reported as INFO, never cause a non-zero exit. Install them on demand
# (with the user's confirmation) only when a route actually needs them.
# Also resolves and exports PDF_SKILL_DIR and FONT_DIR.
# Usage: source env_check.sh  (preferred, exports vars to caller)
#    or: bash env_check.sh [--quiet]
QUIET=false; [ "${1:-}" = "--quiet" ] && QUIET=true
FAIL=0
check() { local desc="$1"; shift; if ! "$@" &>/dev/null; then $QUIET || echo "MISSING (core): $desc"; FAIL=1; fi; }
optional() { local desc="$1"; shift; if "$@" &>/dev/null; then $QUIET || echo "optional OK: $desc"; else $QUIET || echo "optional MISSING: $desc (install on demand)"; fi; }
# LibreOffice is install-on-demand like the others, but it is NOT substitutable: when an
# Office→PDF route needs it and it is absent, the model must explain + warn + install, never
# silently switch to the user's local Office/WPS.
required_on_demand() { local desc="$1"; shift; if "$@" &>/dev/null; then $QUIET || echo "on-demand OK: $desc"; else $QUIET || echo "on-demand MISSING: $desc — if a route needs it you MUST install it, not substitute it. FORBIDDEN: using Word/WPS/Keynote/Pages instead; a large download is NOT a reason to skip. REQUIRED: explain the necessity to the user, say the package is large, then INSTALL (preferred source: https://mirrors.tuna.tsinghua.edu.cn/libreoffice/libreoffice/stable/26.8.0/), THEN register it on PATH and re-verify 'soffice --version' (Linux/macOS: ln -sf the binary into /usr/local/bin; Windows: setx the program dir onto the user PATH) — see env_setup/setup.md \"Register the binary on PATH\". FIRST check whether it is already installed but merely off PATH (/opt/libreoffice*/program/soffice, /Applications/LibreOffice.app/Contents/MacOS/soffice) — if so register it instead of reinstalling. No install attempt = no substitute program."; fi; }

# ── Resolve PDF_SKILL_DIR & FONT_DIR ──
_ENV_CHECK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
PDF_SKILL_DIR="$(cd "$_ENV_CHECK_DIR/.." && pwd)"
export PDF_SKILL_DIR

if [ "$(uname -s)" = "Darwin" ]; then
    FONT_DIR="${HOME}/Library/Fonts"
else
    FONT_DIR="/usr/share/fonts"
fi
export FONT_DIR

# ── CORE (required): Python + ReportLab/pypdf toolchain + CJK font ──
check "python3"    command -v python3
check "pikepdf"    python3 -c "import pikepdf"
check "pdfplumber" python3 -c "import pdfplumber"
check "pypdf"      python3 -c "import pypdf"
check "reportlab"  python3 -c "import reportlab"
check "PyMuPDF"    python3 -c "import fitz"

# Font check: verify an embeddable CJK font is available (SimHei/Noto/WenQuanYi/Songti…)
if command -v fc-list &>/dev/null; then
    fc-list :lang=zh 2>/dev/null | grep -qi "noto\|simhei\|simsun\|songti\|heiti\|wenquanyi\|yahei\|kai" \
        || { $QUIET || echo "MISSING (core): CJK font"; FAIL=1; }
fi

# ── OPTIONAL: Creative/HTML pipeline (Node + Playwright + Chromium) ──
optional "node"       command -v node
optional "playwright (npm)" node -e "require('playwright')"

# ── OPTIONAL: Academic/LaTeX pipeline (Tectonic) ──
if [ -x "$PDF_SKILL_DIR/scripts/tectonic" ] || command -v tectonic &>/dev/null; then
    $QUIET || echo "optional OK: tectonic"
else
    $QUIET || echo "optional MISSING: tectonic (LaTeX/Academic; install on demand)"
fi

# ── ON-DEMAND but NOT substitutable: Office→PDF (LibreOffice/soffice) ──
required_on_demand "libreoffice (soffice)" command -v soffice

$QUIET || echo "PDF_SKILL_DIR=$PDF_SKILL_DIR"
$QUIET || echo "FONT_DIR=$FONT_DIR"
return $FAIL 2>/dev/null || exit $FAIL
