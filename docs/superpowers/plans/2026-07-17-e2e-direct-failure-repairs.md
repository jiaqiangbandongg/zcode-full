# 11 个可直接修复 E2E 失败实施计划

> 依据：`docs/superpowers/specs/2026-07-17-e2e-direct-failure-repairs-design.md`

1. 为 WDIO Coding Plan mock spec gate 添加失败测试，补入 Turbo recovery/switch 两个正式 spec。
2. 为 restart/settings DeepSeek fixture 添加 Anthropic `/messages` 合同测试，更新 I25/I29 对应 main response 和必要标题 response，运行 fixture check。
3. 为权限 option 增加稳定 `data-permission-option-kind` 单测与实现，更新 E2E helper 和刷新 case 的行为断言。
4. 用运行时 toast 证据确认 queue admission 正常，修正仅匹配英文的断言以覆盖中英文 workspace locale。
5. 为 prepend DOM 锚点差值补充纯函数测试，在 loadOlder 触发前捕获锚点、prepend layout effect 中优先校正锚点。
6. 运行受影响单测、E2E fixture check、`pnpm typecheck`、`pnpm lint`；检查 diff 后提交 Conventional Commit。
