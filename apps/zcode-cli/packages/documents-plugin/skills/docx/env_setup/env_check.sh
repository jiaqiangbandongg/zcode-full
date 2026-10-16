#!/usr/bin/env bash
# Lightweight environment check for DOCX skill.
# Exit 0 = all OK, exit 1 = missing dependencies.
# Also resolves and exports DOCX_SKILL_DIR and FONT_DIR.
# Usage: source env_check.sh  (preferred, exports vars to caller)
#    or: bash env_check.sh [--quiet]
QUIET=false; [ "${1:-}" = "--quiet" ] && QUIET=true
FAIL=0
check() { local desc="$1"; shift; if ! "$@" &>/dev/null; then $QUIET || echo "MISSING: $desc"; FAIL=1; fi; }
# LibreOffice is install-on-demand (its absence does not fail this check), but it is NOT
# substitutable: when .doc→.docx / DOCX→PDF / visual verification needs it and it is absent, the
# model must explain + warn + install, never silently switch to the user's local Word/WPS/Pages.
required_on_demand() { local desc="$1"; shift; if "$@" &>/dev/null; then $QUIET || echo "on-demand OK: $desc"; else $QUIET || echo "on-demand MISSING: $desc — if a task needs it you MUST install it, not substitute it. FORBIDDEN: using Word/WPS/Pages instead, or skipping the PDF/visual check; a large download is NOT a reason to skip. REQUIRED: explain the necessity to the user, say the package is large, then INSTALL (preferred source: https://mirrors.tuna.tsinghua.edu.cn/libreoffice/libreoffice/stable/26.8.0/), THEN register it on PATH and re-verify 'soffice --version' (Linux/macOS: ln -sf the binary into /usr/local/bin; Windows: setx the program dir onto the user PATH) — see env_setup/setup.md \"Register the binary on PATH\". FIRST check whether it is already installed but merely off PATH (/opt/libreoffice*/program/soffice, /Applications/LibreOffice.app/Contents/MacOS/soffice) — if so register it instead of reinstalling. No install attempt = no substitute program."; fi; }

# ── Resolve DOCX_SKILL_DIR & FONT_DIR ──
_ENV_CHECK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
DOCX_SKILL_DIR="$(cd "$_ENV_CHECK_DIR/.." && pwd)"
export DOCX_SKILL_DIR

if [ "$(uname -s)" = "Darwin" ]; then
    FONT_DIR="${HOME}/Library/Fonts"
else
    FONT_DIR="/usr/share/fonts"
fi
export FONT_DIR

check "node"        command -v node
check "python3"     command -v python3
check "defusedxml"  python3 -c "import defusedxml"

# Font check
if command -v fc-list &>/dev/null; then
    fc-list :lang=zh 2>/dev/null | grep -qi "noto\|simhei\|wenquanyi" || { $QUIET || echo "MISSING: CJK fonts"; FAIL=1; }
fi

# ── ON-DEMAND but NOT substitutable: .doc→.docx / DOCX→PDF / visual check (LibreOffice/soffice) ──
required_on_demand "libreoffice (soffice)" command -v soffice

$QUIET || echo "DOCX_SKILL_DIR=$DOCX_SKILL_DIR"
$QUIET || echo "FONT_DIR=$FONT_DIR"
return $FAIL 2>/dev/null || exit $FAIL
