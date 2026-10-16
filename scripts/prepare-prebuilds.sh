#!/bin/bash
set -euo pipefail

# Bugfix: shell 版 prepare-prebuilds 已经多次与 mjs 实现漂移，
# 容易一边修了 remote 资源边界，另一边还继续把旧目录和旧注释留在仓库里。
# 这里统一收口到单一实现，避免后续再出现“脚本能跑但目录职责不一致”的双轨问题。
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
exec node "$ROOT_DIR/scripts/prepare-prebuilds.mjs" "$@"
