#!/usr/bin/env bash
# 下载并整理 GLM 平台二进制。
#
# 开发态优先走 ZCODE_AGENT_WORKDIR / 同级仓库源码启动；只有打包态、生产态和无源码的开发环境
# 才需要依赖这个脚本提前准备平台二进制。目录布局统一服务本机打包与远程部署：
# - 当前目标平台输出到 bundled-agents，供本机运行 / 打包直接内置
# - 远程专用平台输出到 mock-cdn，供 remote deploy 按平台拉取

set -euo pipefail
INTRANET_MACHINE_HOST="${INTRANET_MACHINE_HOST:-10.0.0.100}"

PLATFORM="${1:-${ZCODE_TARGET_OS:-$(uname -s | tr '[:upper:]' '[:lower:]')}}"
RAW_ARCH="${2:-${ZCODE_TARGET_ARCH:-$(uname -m)}}"

case "$PLATFORM" in
  mac|macos|darwin|osx) PLATFORM="darwin" ;;
  win|windows|win32) PLATFORM="win32" ;;
  linux) PLATFORM="linux" ;;
esac

case "$RAW_ARCH" in
  x86_64|x64|amd64) ARCH="x64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *) ARCH="$RAW_ARCH" ;;
esac

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
GLM_RUNTIME_VERSION="$(node -e "const fs=require('fs');const source=fs.readFileSync('$REPO_ROOT/packages/shared/src/zcode-agent-runtime.ts','utf8');const match=source.match(/version:\\s*['\"]([^'\"]+)['\"]/);if(!match){throw new Error('Unable to parse ZCode Agent runtime version');}process.stdout.write(match[1]);")"
LOCAL_PLATFORM="${ZCODE_TARGET_OS:-$(uname -s | tr '[:upper:]' '[:lower:]')}"
LOCAL_ARCH="${ZCODE_TARGET_ARCH:-$(uname -m)}"

case "$LOCAL_PLATFORM" in
  mac|macos|darwin|osx) LOCAL_PLATFORM="darwin" ;;
  win|windows|win32) LOCAL_PLATFORM="win32" ;;
  linux) LOCAL_PLATFORM="linux" ;;
esac

case "$LOCAL_ARCH" in
  x86_64|x64|amd64) LOCAL_ARCH="x64" ;;
  aarch64|arm64) LOCAL_ARCH="arm64" ;;
esac

PLATFORM_KEY="$PLATFORM-$ARCH"
LOCAL_KEY="$LOCAL_PLATFORM-$LOCAL_ARCH"

if [ "$PLATFORM_KEY" = "$LOCAL_KEY" ]; then
  OUTPUT_DIR="$REPO_ROOT/packages/desktop/bundled-agents/$PLATFORM_KEY/glm"
else
  OUTPUT_DIR="$REPO_ROOT/packages/desktop/mock-cdn/releases/$(node -p "require('$REPO_ROOT/package.json').version")/glm/$PLATFORM_KEY"
fi

BINARY_NAME="zcode-agent"
if [ "$PLATFORM" = "win32" ]; then
  BINARY_NAME="zcode-agent.exe"
fi

# Bugfix: GLM 二进制按 zcode-cli 版本发布，默认下载目录必须跟随 shared runtime 里的 glm.version。
DOWNLOAD_BASE_URL="${GLM_BINARY_DOWNLOAD_BASE_URL:-http://${INTRANET_MACHINE_HOST}:12345/zcode/deps/zcode-cli-${GLM_RUNTIME_VERSION}}"
# Bugfix：Windows 制品命名恢复为 zcode-windows-*.exe，避免继续请求错误文件名。
DOWNLOAD_NAME="zcode-${PLATFORM}-${ARCH}"
if [ "$PLATFORM" = "win32" ]; then
  DOWNLOAD_NAME="zcode-windows-${ARCH}.exe"
fi
DOWNLOAD_URL="${DOWNLOAD_BASE_URL}/${DOWNLOAD_NAME}"

echo "==> glm binary download"
echo "    platform: ${PLATFORM_KEY}"
echo "    target:   ${OUTPUT_DIR}/${BINARY_NAME}"

if [ -f "$OUTPUT_DIR/$BINARY_NAME" ]; then
  echo "    [skip] 已存在，跳过"
  exit 0
fi

mkdir -p "$OUTPUT_DIR"
# Bugfix: /tmp 与仓库目录跨挂载时 mv 会 EXDEV；临时文件放在输出目录内。
TMPFILE="$(mktemp "${OUTPUT_DIR}/.glm-dl-XXXXXXXXXX.part")"
trap 'rm -f "$TMPFILE"' EXIT

echo "    [download] ${DOWNLOAD_URL}"
curl -fSL --progress-bar -o "$TMPFILE" "$DOWNLOAD_URL"

mv "$TMPFILE" "$OUTPUT_DIR/$BINARY_NAME"

if [ "$PLATFORM" != "win32" ]; then
  chmod +x "$OUTPUT_DIR/$BINARY_NAME" 2>/dev/null || true
fi

echo "==> Done! glm (${PLATFORM_KEY}) -> ${OUTPUT_DIR}/${BINARY_NAME}"
