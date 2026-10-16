# 本地评测 Computer Use Helper(dev 构建)— Runbook

> 本笔记记录 dev Helper 构建相关的关键事实。dev Helper 的构建脚本
> （`scripts/build-cua-helper-app.mjs`）与稳定签名身份工具
> （`scripts/ensure-cua-helper-dev-identity.mjs`）都在本仓（z-code）；
> producer（zcode-cua）仓的 `docs/cua-permission-broker/` 另有评测侧笔记。

## 稳定 TCC 授权（一次性设置，消除每次 rebuild 重新授权）

**问题**：dev Helper 每次 rebuild 后 CDHash 变化，macOS 把它当新 app，要求重新授予
Accessibility + Screen Recording——开发迭代时每轮都要手动授权，严重拖慢速度。

**解决**（z-code 仓 `scripts/ensure-cua-helper-dev-identity.mjs`）：一次性创建自签
证书 `zcode-cua-helper-dev` 存入 login keychain，此后所有 dev Helper 用它签名 →
designated requirement 锚定证书公钥（稳定）而非 CDHash → **TCC 授权跨 rebuild 持久**。

**标准流程**（新机器 / 首次）：

```bash
# ⚠️ 必须在本地 GUI 终端（Terminal/ghostty）跑，SSH 会话会被 macOS 拒绝
#    （"User interaction is not allowed"——keychain 写操作要求 GUI audit session）
cd <z-code 仓> && node scripts/ensure-cua-helper-dev-identity.mjs
# 弹出信任对话框时点「始终信任」。之后 rebuild 永远不再弹 TCC 授权。
```

**SSH/agent 会话的协作流程**（2026-08-16 固化）：

1. 任何会话（含 SSH）跑一次 `node scripts/ensure-cua-helper-dev-identity.mjs`——
   它会生成并把密钥**持久化**到 `~/.zcode/cua-helper-dev-identity/`，然后 import
   失败并给出精确指引（`import_needs_gui_session`）。
2. 用户在**本地 GUI 终端**跑 `node scripts/ensure-cua-helper-dev-identity.mjs --reimport`——复用第 1 步持久化的同一密钥（不重新生成），完成 import + trust。
3. 之后 `pnpm build:cua-helper:dev`（= `build-cua-helper-app.mjs --allow-unsigned-launcher-local-dev`）自动用稳定身份签名；构建输出不再出现
   adhoc 警告。注意：裸 `pnpm build:cua-helper` 不带 dev flag，走的是 release
   产物路径（adhoc 临时封装，后续 Developer ID 重签），不会使用 dev identity。

**防护**（同步固化）：

- build 脚本在稳定 dev identity 签名失败时默认**拒绝产出** adhoc dev build（提示
  改用一次性修复命令）；确要临时 adhoc 时显式设 `ZCODE_CUA_HELPER_ALLOW_ADHOC=1`
  （脚本会同步打印 TCC 授权将不保的警告）。
- `ZCODE_CUA_ADDON_PATH=<producer>/build/Release/ax_native.node` 允许 producer
  worktree 的 freshly-built addon 直接进 helper 包——否则 build 静默使用 consumer
  `node_modules` 里的**旧 addon**（按 pinned commit 编译），producer native 修复
  根本没进包，白烧一轮 TCC 授权才能发现（2026-08-16 实际踩坑）。

## Native 模块:sharp 已正确打进 dev Helper(wave-10)

dev Helper 现在会把 `sharp` 的原生 prebuild 暂存进
`ZCode Computer Use Dev.app/Contents/Resources/node_modules/`（镜像产品侧 D-018 的做法）。
`require('sharp')` 返回一个 function;RGBA→resize→JPEG 的功能管线已真机验证通过。

- 修复脚本:`scripts/build-cua-helper-app.mjs`(z-code-toolset 仓)。
- 此前症状:dev Helper 内 `require('sharp')` 失败,截图后端跑不了 resize / 编码。
- 验证口径:wave-10 真机测试,functional RGBA→resize→JPEG pipeline 通过。

> 历史背景:产品侧 D-018(commit `f811c910fd`,`fix(desktop): package sharp into ZCode.app for product CUA server`)已把 sharp 打进 product Helper;wave-10 把
> 同一套暂存逻辑补进 dev Helper 构建脚本,消除 dev / product 在 sharp 上的差异。
