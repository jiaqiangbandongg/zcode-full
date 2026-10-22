# 侧栏“显示更多”闪动修复记录

对应 spec：`docs/superpowers/specs/2026-09-11-project-sidebar-width-stability.md`。

## 与预期不符的事实

- 恢复旧分区时增加了 `grid gap-3`，却没有约束隐式列的最小宽度。旧代码的普通块布局没有这一行为。TaskTitleOverflowText 的滚动副本因此影响父列宽度，形成“溢出→加副本→撑宽→不溢出→删副本”的布局反馈。
- 本机真实 renderer 在鼠标移动次数为 0 的对照中，容器宽度一直为 586px，按钮宽度却在 637.695px 与 1237.492px 间交替，标题副本数随之在 0/2 间变化。临时施加单列约束后按钮稳定为 570px；恢复原样后复现。此处不涉及任务行集合或数据库变化。
- 原 UI 回归覆盖了空项目与少量任务，没有用长标题触发 Grid intrinsic sizing；本次新增隔离 HOME 的 25+25 条长短标题真实 Electron 分页回归。合成任务索引仅服务布局，不创建真实 CLI 历史、不触发 provider 请求。
- 运行中打开 DevTools 后，agent-browser 每次传 `--cdp` 会选中新的 DevTools target；随后的空侧栏结果无效。改为按 ZCode 标题及 localhost URL 固定 CDP page 后再进行对照，未把目标切换误判为产品卸载。

## 验证

修复前 pending E2E 在分区宽度断言失败：溢出 686.015625px（允许误差 1px）。实现只增加 `grid-cols-1` 及中文原因注释，不修改标题测量、分页状态或数据层。

修复后重新构建运行：`desktop-e2e-20260911045425289-p13513-f9e2908aae9f6465` 通过。两主题 × 正常/240px 分区共四组，每组 146 个样本，无横向溢出、按钮宽度跳变为 0，居中误差最大 0.00390625px；两个分区均 20→25 分页成功。12 项相关单测、root typecheck、typecheck:e2e、fixture check、lint（48 项既有 warning / 0 error）通过；architecture baseline/new/violations 均为 0。手机使用同一容器 CSS，本轮只验证窄容器布局，不宣称手机 relay 端到端流程覆盖。

代码含 E2E 新增 151 行、删除 1 行，净增 150 行；生产改动仅单列约束与原因注释。未改项目/任务数据 owner、同步链路或数据库。
