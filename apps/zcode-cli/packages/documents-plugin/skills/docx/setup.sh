#!/usr/bin/env bash
# ---
# name: docx-setup
# author: Z.AI
# version: "1.0"
# description: Environment setup for the DOCX skill. Checks and installs all required dependencies.
# ---
#
# Installs only dependencies required by the DOCX skill.
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
ok() { echo -e "  ${GREEN}✓${NC} $1"; }
fail() { echo -e "  ${RED}✗${NC} $1"; }
warn() { echo -e "  ${YELLOW}○${NC} $1"; }
info() { echo -e "  ${BLUE}→${NC} $1"; }

echo "============================================"
echo "  DOCX Skill — Environment Setup"
echo "============================================"
echo ""

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
        fail "brew not found — Node.js install needs Homebrew on macOS"
        info "Install: /bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\""
    fi
    echo ""
fi

# ── 1. Node.js (docx-js runs on Node) ──
echo "--- Node.js ---"
if command -v node &>/dev/null; then
    NODE_VER=$(node --version)
    ok "node ($NODE_VER)"
else
    fail "node not found (required — docx generation uses docx-js on Node)"
    case "$OS" in
        Darwin) info "Install: brew install node" ;;
        Linux)  info "Install: curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -"
                info "         sudo apt install -y nodejs" ;;
        *)      info "Install: https://nodejs.org/" ;;
    esac
fi

# ── 2. npm ──
echo ""
echo "--- npm ---"
if command -v npm &>/dev/null; then
    NPM_VER=$(npm --version 2>/dev/null)
    ok "npm ($NPM_VER)"
else
    fail "npm not found"
    case "$OS" in
        Darwin) info "Install: brew install node (includes npm)" ;;
        Linux)  info "Install: comes with nodejs" ;;
        *)      info "Install: https://nodejs.org/" ;;
    esac
fi

# ── 3. npm package: docx ──
echo ""
echo "--- npm Packages ---"
if node -e "require('docx')" 2>/dev/null || npm list -g docx &>/dev/null; then
    DOCX_VER=$(node -e "try{console.log(require('docx/package.json').version)}catch(e){console.log('installed')}" 2>/dev/null)
    ok "docx ($DOCX_VER)"
else
    fail "docx not installed"
    info "Install: npm install -g docx"
    echo ""
    if [ -t 0 ]; then
        read -p "  Install now? [Y/n] " -n 1 -r REPLY
        echo ""
        REPLY=${REPLY:-Y}
    else
        warn "Non-interactive mode — skipping auto-install."
        REPLY=N
    fi
    if [[ ! $REPLY =~ ^[Nn]$ ]]; then
        npm install -g docx 2>/dev/null && ok "Installed: docx" || fail "npm install failed"
    fi
fi

# ── 4. Python 3 (post-processing scripts) ──
echo ""
echo "--- Python (post-processing) ---"
if command -v python3 &>/dev/null; then
    PY_VER=$(python3 --version 2>&1)
    ok "python3 ($PY_VER)"
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

# ── 5. pip ──
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

# ── 6. Python packages ──
echo ""
echo "--- Python Packages ---"
PY_PKGS=(
    "defusedxml:defusedxml"
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

# ── LibreOffice (install-on-demand, NOT substitutable) ──
echo ""
echo "--- LibreOffice (.doc→.docx, DOCX→PDF, visual verification) ---"
if command -v soffice &>/dev/null; then
    LO_VER=$(soffice --version 2>/dev/null | head -1)
    ok "libreoffice ($LO_VER)"
else
    warn "libreoffice not installed — REQUIRED for .doc→.docx, DOCX→PDF, visual checks"
    info "You MUST install it. FORBIDDEN: using Word/WPS/Pages instead of installing,"
    info "or skipping the PDF/visual check. A large download is NOT a reason to skip."
    info "REQUIRED: explain the necessity to the user, say the package is large, THEN install."
    info "PREFERRED source (fast in China, current build): Tsinghua TUNA mirror"
    info "  https://mirrors.tuna.tsinghua.edu.cn/libreoffice/libreoffice/stable/26.8.0/"
    info "  Pick the subdir for this platform/arch ($(uname -m)):"
    info "    Linux deb  -> deb/x86_64/ or deb/aarch64/   (tar -xzf, then dpkg -i */DEBS/*.deb)"
    info "    Linux rpm  -> rpm/x86_64/"
    info "    macOS      -> mac/aarch64/ (Apple Silicon) or mac/x86_64/ (Intel)  (.dmg)"
    info "  If 26.8.0 is gone, pick the newest version under .../libreoffice/stable/"
    info "Package-manager FALLBACK (only if the mirror is unreachable):"
    case "$(uname -s)" in
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

# ── Summary ──
echo ""
echo "============================================"
echo "  Setup complete."
echo "  Core: Node.js + docx (npm)"
echo "  Post-processing: Python + defusedxml"
echo "  On-demand (not substitutable): LibreOffice"
echo "============================================"
