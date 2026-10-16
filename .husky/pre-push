#!/usr/bin/env sh

# 推送前先跑 lint 再跑单测，先用更快的静态检查尽早拦住低成本问题，
# 避免还没过代码质量门槛就进入更慢的测试阶段。
# Git 会通过 stdin 传入本次 push 的 local/remote ref 与 sha；先缓存下来，后续
# affected-test 脚本才能用远端当前 sha 作为 base，而不是误退回到默认分支。
# 手工执行 hook 时 stdin 可能是终端，避免直接 cat 卡住调试。
pre_push_stdin=""
if [ ! -t 0 ]; then
  pre_push_stdin=$(cat)
fi
# Bugfix: Git hook 会注入 GIT_DIR/GIT_WORK_TREE 等 local env。
# 不清理会让单测里的临时仓库 Git 命令误命中当前仓库（例如把功能分支改名为 main）。
# shellcheck disable=SC2046
unset $(git rev-parse --local-env-vars)
# 修复原因：强制 mise 会阻止已用其他方式准备好 Node/pnpm 的开发者推送；沿用当前环境。
ZCODE_PRE_PUSH_STDIN="$pre_push_stdin" pnpm run verify:pre-push
