#!/usr/bin/env bash
# ---
# name: pdf-setup
# author: Z.AI
# version: "1.0"
# description: Environment setup for the PDF skill. Checks/installs CORE deps (Python + ReportLab/pypdf/PyMuPDF/pikepdf/pdfplumber + CJK font). Playwright/Chromium and Tectonic are OPTIONAL — install on demand.
# ---
#
# Installs only dependencies required by the PDF skill.
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
ok() { echo -e "  ${GREEN}✓${NC} $1"; }
fail() { echo -e "  ${RED}✗${NC} $1"; }
warn() { echo -e "  ${YELLOW}○${NC} $1"; }
info() { echo -e "  ${BLUE}→${NC} $1"; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "============================================"
echo "  PDF Skill — Environment Setup"
echo "============================================"
echo ""

# ── Detect platform ──
OS="$(uname -s)"
ARCH="$(uname -m)"
echo "Platform: $OS $ARCH"
echo ""

# ── 0. macOS: Homebrew ──
if [ "$OS" = "Darwin" ]; then
    echo "--- Homebrew (macOS package manager) ---"
    if command -v brew &>/dev/null; then
        BREW_VER=$(brew --version 2>/dev/null | head -1)
        ok "brew ($BREW_VER)"
    else
        fail "brew not found — most dependencies below need Homebrew on macOS"
        info "Install: /bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\""
    fi
    echo ""
fi

# ── 1. Python 3 ──
echo "--- Python ---"
if command -v python3 &>/dev/null; then
    PY_VER=$(python3 --version 2>&1)
    ok "python3 ($PY_VER)"
    # macOS: warn if using system Python
    if [ "$OS" = "Darwin" ]; then
        PY_PATH=$(which python3 2>/dev/null)
        if [[ "$PY_PATH" == "/usr/bin/python3" ]]; then
            warn "Using macOS system Python (limited). Recommend: brew install python3"
        fi
    fi
else
    fail "python3 not found"
    case "$OS" in
        Darwin) info "Install: brew install python3" ;;
        Linux)  info "Install: sudo apt install python3 python3-pip  (Debian/Ubuntu)"
                info "         sudo dnf install python3 python3-pip  (Fedora/RHEL)" ;;
        *)      info "Install: https://www.python.org/downloads/" ;;
    esac
fi

# ── 2. pip ──
echo ""
echo "--- pip ---"
if python3 -m pip --version &>/dev/null 2>&1; then
    PIP_VER=$(python3 -m pip --version 2>/dev/null | head -1)
    ok "pip ($PIP_VER)"
else
    fail "pip not found"
    case "$OS" in
        Darwin) info "Install: python3 -m ensurepip --upgrade"
                info "     or: brew install python3 (includes pip)" ;;
        Linux)  info "Install: sudo apt install python3-pip  (Debian/Ubuntu)" ;;
        *)      info "Install: python3 -m ensurepip --upgrade" ;;
    esac
fi

# ── 3. Python packages (pip) ──
echo ""
echo "--- Python Packages ---"
PY_PKGS=(
    "pikepdf:pikepdf"
    "pdfplumber:pdfplumber"
    "pypdf:pypdf"
    "reportlab:reportlab"
    "pymupdf:PyMuPDF"
)

MISSING_PY=()
for entry in "${PY_PKGS[@]}"; do
    mod="${entry%%:*}"
    pkg="${entry##*:}"
    if python3 -c "import $mod" 2>/dev/null; then
        ver=$(python3 -c "import $mod; print(getattr($mod, '__version__', 'installed'))" 2>/dev/null)
        ok "$pkg ($ver)"
    else
        fail "$pkg not installed"
        MISSING_PY+=("$pkg")
    fi
done

if [ ${#MISSING_PY[@]} -gt 0 ]; then
    echo ""
    if [ -t 0 ]; then
        read -p "  Install missing Python packages? [Y/n] " -n 1 -r REPLY
        echo ""
        REPLY=${REPLY:-Y}
    else
        warn "Non-interactive mode — skipping auto-install. Run interactively or install manually."
        REPLY=N
    fi
    if [[ ! $REPLY =~ ^[Nn]$ ]]; then
        python3 -m pip install -q "${MISSING_PY[@]}" 2>/dev/null \
            || python3 -m pip install -q --user "${MISSING_PY[@]}" 2>/dev/null \
            || python3 -m pip install -q --break-system-packages "${MISSING_PY[@]}" 2>/dev/null \
            || { fail "pip install failed. Try manually: pip install ${MISSING_PY[*]}"; }
        ok "Installed: ${MISSING_PY[*]}"
    fi
fi

# ── 4. Node.js (OPTIONAL — Creative/HTML pipeline only) ──
echo ""
echo "--- Node.js (optional: Creative/HTML pipeline) ---"
if command -v node &>/dev/null; then
    NODE_VER=$(node --version)
    ok "node ($NODE_VER)"
else
    warn "node not found (optional — only needed for the Creative/poster/HTML→PDF route)"
    case "$OS" in
        Darwin) info "Install on demand: brew install node" ;;
        Linux)  info "Install on demand: curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -"
                info "                   sudo apt install -y nodejs" ;;
        *)      info "Install on demand: https://nodejs.org/" ;;
    esac
fi

# ── 5. npm (OPTIONAL) ──
echo ""
echo "--- npm (optional) ---"
if command -v npm &>/dev/null; then
    NPM_VER=$(npm --version 2>/dev/null)
    ok "npm ($NPM_VER)"
else
    warn "npm not found (optional — bundled with Node.js)"
    case "$OS" in
        Darwin) info "Install on demand: brew install node (includes npm)" ;;
        Linux)  info "Install on demand: comes with nodejs" ;;
        *)      info "Install on demand: https://nodejs.org/" ;;
    esac
fi

# ── 6. Playwright + Chromium (OPTIONAL — Creative/HTML pipeline only) ──
echo ""
echo "--- Playwright + Chromium (optional: HTML→PDF engine) ---"
info "Optional. Covers now render with ReportLab; Playwright is only for Creative/poster/HTML→PDF."
info "Install on demand, with the user's confirmation (large download / long first-run wait)."
if node -e "require('playwright')" 2>/dev/null; then
    PW_VER=$(node -e "console.log(require('playwright/package.json').version)" 2>/dev/null)
    ok "playwright ($PW_VER)"
else
    warn "playwright not installed (optional)"
    info "Install on demand: npm install -g playwright"
fi

# Check Chromium
if [ "$OS" = "Darwin" ]; then
    PW_CACHE="$HOME/Library/Caches/ms-playwright"
else
    PW_CACHE="$HOME/.cache/ms-playwright"
fi
if ls "$PW_CACHE"/chromium-* &>/dev/null 2>&1; then
    CR_DIR=$(ls -d "$PW_CACHE"/chromium-* 2>/dev/null | tail -1)
    ok "chromium ($(basename "$CR_DIR"))"
else
    warn "chromium not installed (optional)"
    info "Install on demand: npx playwright install chromium"
    if [ "$OS" = "Linux" ]; then
        info "                  npx playwright install-deps  (system libs, needs sudo)"
    fi
fi

# ── 7. Tectonic (LaTeX engine, optional) ──
echo ""
echo "--- Tectonic (LaTeX→PDF, optional) ---"
BUNDLED="$SCRIPT_DIR/tectonic"
if [ -x "$BUNDLED" ]; then
    if [ "$OS" = "Darwin" ] && [ "$ARCH" = "arm64" ]; then
        ok "tectonic (bundled, macOS arm64)"
    else
        warn "bundled tectonic is macOS arm64 only — cannot run on $OS $ARCH"
        if command -v tectonic &>/dev/null; then
            TEC_VER=$(tectonic --version 2>&1 | head -1)
            ok "tectonic (system: $TEC_VER)"
        else
            fail "tectonic not in PATH"
            case "$OS" in
                Darwin) info "Install: brew install tectonic" ;;
                Linux)  info "Install: conda install -c conda-forge tectonic"
                        info "     or: curl -fsSL https://drop-sh.fullyjustified.net | sh" ;;
                MINGW*|MSYS*|CYGWIN*) info "Install: scoop install tectonic  /  choco install tectonic" ;;
            esac
        fi
    fi
elif command -v tectonic &>/dev/null; then
    TEC_VER=$(tectonic --version 2>&1 | head -1)
    ok "tectonic ($TEC_VER)"
elif [ -x "$HOME/tectonic" ]; then
    ok "tectonic (~/tectonic)"
else
    warn "tectonic not installed (needed only for LaTeX/academic PDFs)"
    case "$OS" in
        Darwin) info "Install: brew install tectonic" ;;
        Linux)  info "Install: conda install -c conda-forge tectonic"
                info "     or: curl -fsSL https://drop-sh.fullyjustified.net | sh" ;;
        MINGW*|MSYS*|CYGWIN*) info "Install: scoop install tectonic  /  choco install tectonic" ;;
    esac
fi

# ── 8. LibreOffice (install-on-demand, NOT substitutable) ──
echo ""
echo "--- LibreOffice (Office→PDF) ---"
if command -v soffice &>/dev/null; then
    LO_VER=$(soffice --version 2>/dev/null | head -1)
    ok "libreoffice ($LO_VER)"
else
    warn "libreoffice not installed — REQUIRED for any .docx/.xlsx/.pptx→PDF task"
    info "You MUST install it. FORBIDDEN: using Word/WPS/Keynote/Pages instead of"
    info "installing. A large download is NOT a reason to skip -- it is expected to be"
    info "large. REQUIRED: explain the necessity to the user, say the package is large,"
    info "THEN install it."
    info "PREFERRED source (fast in China, current build): Tsinghua TUNA mirror"
    info "  https://mirrors.tuna.tsinghua.edu.cn/libreoffice/libreoffice/stable/26.8.0/"
    info "  Pick the subdir for this platform/arch ($(uname -m)):"
    info "    Linux deb  -> deb/x86_64/ or deb/aarch64/   (tar -xzf, then dpkg -i */DEBS/*.deb)"
    info "    Linux rpm  -> rpm/x86_64/"
    info "    macOS      -> mac/aarch64/ (Apple Silicon) or mac/x86_64/ (Intel)  (.dmg)"
    info "  If 26.8.0 is gone, pick the newest version under .../libreoffice/stable/"
    info "Package-manager FALLBACK (only if the mirror is unreachable):"
    case "$OS" in
        Darwin) info "  brew install --cask libreoffice" ;;
        Linux)  info "  sudo apt install libreoffice-core  (Debian/Ubuntu)" ;;
    esac
    info "AFTER installing, REGISTER the binary on PATH -- the method differs per OS:"
    case "$OS" in
        Darwin) info "  sudo ln -sf /Applications/LibreOffice.app/Contents/MacOS/soffice /usr/local/bin/soffice"
                info "  (Apple Silicon: use /opt/homebrew/bin/soffice if /usr/local/bin is not on PATH)" ;;
        Linux)  info "  sudo ln -sf /opt/libreoffice*/program/soffice /usr/local/bin/soffice" ;;
    esac
    info "  then re-verify: soffice --version"
    info "An install left off PATH looks 'not installed' next run and gets reinstalled"
    info "needlessly. If soffice already exists on disk but is off PATH, just link it."
    info "Another program is allowed ONLY after an install attempt has FAILED. Report it."
    info "No install attempt = no substitute program."
fi

# ── 9. CJK Fonts ──
echo ""
echo "--- CJK Fonts ---"
FONT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)/fonts"
if [ -d "$FONT_DIR" ]; then
    FONT_COUNT=$(find "$FONT_DIR" -name "*.ttf" -o -name "*.otf" 2>/dev/null | head -20 | wc -l | tr -d ' ')
    ok "fonts directory ($FONT_COUNT font files in $FONT_DIR)"
else
    warn "no fonts/ directory found — CJK PDFs may have missing glyphs"
    info "Expected at: $FONT_DIR"
fi
# Check system CJK fonts
if [ "$OS" = "Darwin" ]; then
    if ls /System/Library/Fonts/PingFang.ttc &>/dev/null 2>&1 \
       || ls /System/Library/Fonts/STHeiti*.ttc &>/dev/null 2>&1 \
       || ls "$HOME/Library/Fonts/"*SimHei* &>/dev/null 2>&1; then
        ok "macOS CJK system fonts available"
    else
        warn "no common CJK system fonts found"
    fi
elif [ "$OS" = "Linux" ]; then
    if fc-list :lang=zh 2>/dev/null | head -1 | grep -q .; then
        ok "system CJK fonts available (fc-list)"
    else
        warn "no CJK fonts found. Install: sudo apt install fonts-noto-cjk"
    fi
fi

# ── Summary ──
echo ""
echo "============================================"
echo "  Setup complete."
echo "  Run 'python3 pdf.py env.check' for detailed status."
echo "  Run 'python3 pdf.py env.fix'   to auto-install Python deps."
echo "============================================"
