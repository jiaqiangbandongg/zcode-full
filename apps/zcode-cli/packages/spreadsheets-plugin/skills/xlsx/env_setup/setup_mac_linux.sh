#!/usr/bin/env bash
# ---
# name: xlsx-env-setup (macOS / Linux)
# description: Environment detection, dependency check & install for XLSX skill on macOS and Linux.
# ---
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
ok()   { echo -e "  ${GREEN}✓${NC} $1"; }
fail() { echo -e "  ${RED}✗${NC} $1"; }
warn() { echo -e "  ${YELLOW}○${NC} $1"; }
info() { echo -e "  ${BLUE}→${NC} $1"; }

# ── Resolve XLSX_SKILL_DIR ──
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
XLSX_SKILL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
export XLSX_SKILL_DIR

echo "============================================"
echo "  XLSX Skill — Environment Setup"
echo "  (macOS / Linux)"
echo "============================================"
echo ""

# ── Step 1: Platform Detection ──
OS="$(uname -s)"
ARCH="$(uname -m)"
echo "Platform: $OS $ARCH"

if [ "$OS" = "Darwin" ]; then
    PLATFORM="mac"
elif [ "$OS" = "Linux" ]; then
    PLATFORM="linux"
else
    echo "Unsupported platform: $OS. For Windows use env_setup/setup_windows.ps1"
    exit 1
fi

echo "Detected: $PLATFORM"
echo "XLSX_SKILL_DIR=$XLSX_SKILL_DIR"
echo ""

# ── China mirror detection & config ──
USE_CN_MIRROR=false
PIP_MIRROR_ARGS=""

if [ "${USE_CN_MIRROR_FORCE:-}" = "true" ]; then
    USE_CN_MIRROR=true
elif curl -s --connect-timeout 3 https://pypi.org > /dev/null 2>&1; then
    USE_CN_MIRROR=false
else
    warn "pypi.org unreachable — enabling China mirrors"
    USE_CN_MIRROR=true
fi

if [ "$USE_CN_MIRROR" = true ]; then
    PIP_MIRROR_ARGS="-i https://pypi.tuna.tsinghua.edu.cn/simple --trusted-host pypi.tuna.tsinghua.edu.cn"
    info "China mirrors enabled (pip: tuna)"
    echo ""
fi

ERRORS=0

# ── Step 2a: Homebrew (macOS only) ──
if [ "$PLATFORM" = "mac" ]; then
    echo "--- [1/6] Homebrew (macOS package manager) ---"
    if command -v brew &>/dev/null; then
        ok "brew installed"
    else
        fail "brew not found"
        info "Install: /bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\""
        ERRORS=$((ERRORS + 1))
    fi
    echo ""
fi

# ── Step 2b: Python 3 ──
echo "--- [2/6] Python 3 ---"
if command -v python3 &>/dev/null; then
    PY_VER=$(python3 --version 2>&1)
    ok "python3 ($PY_VER)"
    if [ "$PLATFORM" = "mac" ]; then
        PY_PATH=$(which python3 2>/dev/null)
        if [[ "$PY_PATH" == "/usr/bin/python3" ]]; then
            warn "Using macOS system Python (limited). Recommend: brew install python3"
        fi
    fi
else
    fail "python3 not found"
    case "$PLATFORM" in
        mac)   info "Install: brew install python3" ;;
        linux) info "Install: sudo apt install python3 python3-pip" ;;
    esac
    ERRORS=$((ERRORS + 1))
fi

if python3 -m pip --version &>/dev/null 2>&1; then
    ok "pip installed"
else
    fail "pip not found"
    case "$PLATFORM" in
        mac)   info "Install: python3 -m ensurepip --upgrade" ;;
        linux) info "Install: sudo apt install python3-pip" ;;
    esac
    ERRORS=$((ERRORS + 1))
fi
echo ""

# ── Step 2c: Python packages ──
echo "--- [3/6] Python Packages (openpyxl, XlsxWriter) ---"
PY_PKGS=(
    "openpyxl:openpyxl"
    "xlsxwriter:XlsxWriter"
)

MISSING_PY=()
for entry in "${PY_PKGS[@]}"; do
    mod="${entry%%:*}"
    pkg="${entry##*:}"
    if python3 -c "import $mod" 2>/dev/null; then
        ver=$(python3 -c "import $mod; print(getattr($mod, '__version__', 'ok'))" 2>/dev/null)
        ok "$pkg ($ver)"
    else
        fail "$pkg not installed"
        MISSING_PY+=("$pkg")
    fi
done

if [ ${#MISSING_PY[@]} -gt 0 ]; then
    info "Installing missing Python packages: ${MISSING_PY[*]}"
    # shellcheck disable=SC2086
    python3 -m pip install -q $PIP_MIRROR_ARGS "${MISSING_PY[@]}" 2>/dev/null \
        || python3 -m pip install -q --user $PIP_MIRROR_ARGS "${MISSING_PY[@]}" 2>/dev/null \
        || python3 -m pip install -q --break-system-packages $PIP_MIRROR_ARGS "${MISSING_PY[@]}" 2>/dev/null \
        || { fail "pip install failed. Try: pip install $PIP_MIRROR_ARGS ${MISSING_PY[*]}"; ERRORS=$((ERRORS + 1)); }
    ok "Installed: ${MISSING_PY[*]}"
fi
echo ""

# ── Step 2d: LibreOffice (install-on-demand, NOT substitutable) ──
echo "--- [4/6] LibreOffice (format conversion + formula recalc) ---"
if command -v soffice &>/dev/null; then
    LO_VER=$(soffice --version 2>/dev/null | head -1)
    ok "libreoffice ($LO_VER)"
else
    warn "libreoffice not installed — REQUIRED for recalc, .xlsx→PDF, .csv→.xlsx"
    info "You MUST install it. FORBIDDEN: using Excel/WPS/Numbers instead of installing,"
    info "or skipping recalculation. A large download is NOT a reason to skip. REQUIRED:"
    info "explain the necessity to the user, say the package is large, THEN install it."
    info "PREFERRED source (fast in China, current build): Tsinghua TUNA mirror"
    info "  https://mirrors.tuna.tsinghua.edu.cn/libreoffice/libreoffice/stable/26.8.0/"
    info "  Pick the subdir for this platform/arch ($(uname -m)):"
    info "    Linux deb  -> deb/x86_64/ or deb/aarch64/   (tar -xzf, then dpkg -i */DEBS/*.deb)"
    info "    Linux rpm  -> rpm/x86_64/"
    info "    macOS      -> mac/aarch64/ (Apple Silicon) or mac/x86_64/ (Intel)  (.dmg)"
    info "  If 26.8.0 is gone, pick the newest version under .../libreoffice/stable/"
    info "Package-manager FALLBACK (only if the mirror is unreachable):"
    case "$PLATFORM" in
        mac)   info "  brew install --cask libreoffice" ;;
        linux) info "  sudo apt install libreoffice-core" ;;
    esac
    info "AFTER installing, REGISTER the binary on PATH -- the method differs per OS:"
    case "$PLATFORM" in
        mac)   info "  sudo ln -sf /Applications/LibreOffice.app/Contents/MacOS/soffice /usr/local/bin/soffice"
               info "  (Apple Silicon: use /opt/homebrew/bin/soffice if /usr/local/bin is not on PATH)" ;;
        linux) info "  sudo ln -sf /opt/libreoffice*/program/soffice /usr/local/bin/soffice" ;;
    esac
    info "  then re-verify: soffice --version"
    info "An install left off PATH looks 'not installed' next run and gets reinstalled"
    info "needlessly. If soffice already exists on disk but is off PATH, just link it."
    info "Another program is allowed ONLY after an install attempt has FAILED. Report it."
    info "No install attempt = no substitute program."
fi
echo ""

# ── Step 2e: Font Verification (local /usr/share/fonts/) ──
echo "--- [5/6] Font Verification ---"
FONT_BASE="/usr/share/fonts"
FONT_LIST="$SCRIPT_DIR/font_list.txt"

if [ ! -f "$FONT_LIST" ]; then
    fail "Font list not found: $FONT_LIST"
    ERRORS=$((ERRORS + 1))
else
    TOTAL=$(wc -l < "$FONT_LIST" | tr -d ' ')
    FOUND=0
    MISSING=0
    info "Verifying $TOTAL fonts in $FONT_BASE ..."

    while IFS= read -r rel_path || [ -n "$rel_path" ]; do
        [ -z "$rel_path" ] && continue
        if [ -f "$rel_path" ]; then
            FOUND=$((FOUND + 1))
        else
            warn "Missing font: $rel_path"
            MISSING=$((MISSING + 1))
        fi
    done < "$FONT_LIST"

    if [ $MISSING -eq 0 ]; then
        ok "All $FOUND fonts found in $FONT_BASE"
    else
        warn "Fonts: $FOUND found, $MISSING missing in $FONT_BASE"
        ERRORS=$((ERRORS + 1))
    fi
fi

# Set FONT_DIR to system font directory
FONT_DIR="$FONT_BASE"
export FONT_DIR
echo ""

# ── Step 2f: CJK Font Verification ──
echo "--- [6/6] CJK Font Verification ---"
CJK_FOUND=false

if [ -f "$FONT_BASE/truetype/chinese/NotoSansSC[wght].ttf" ]; then
    ok "Noto Sans SC found in $FONT_BASE"
    CJK_FOUND=true
elif fc-list :lang=zh 2>/dev/null | head -1 | grep -q .; then
    ok "CJK fonts available (fc-list)"
    CJK_FOUND=true
fi

if [ "$CJK_FOUND" = false ]; then
    warn "No CJK font detected in $FONT_BASE — ensure fonts are pre-installed"
fi
echo ""

# ── Summary ──
echo "============================================"
if [ $ERRORS -eq 0 ]; then
    echo "  All dependencies OK."
else
    echo "  $ERRORS issue(s) found. Fix them above."
fi
echo "  XLSX_SKILL_DIR=$XLSX_SKILL_DIR"
echo "  FONT_DIR=$FONT_DIR (system font directory)"
echo "============================================"
