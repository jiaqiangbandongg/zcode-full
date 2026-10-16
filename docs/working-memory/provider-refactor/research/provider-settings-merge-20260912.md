# Provider Settings 本地分支整合（2026-09-12）

## 范围与裁决

- 当前分支基线：`5bf148568d`；来源 `provider-settings-todos` 固定为 `d3b8b937b1`。
- 来源的独立三笔提交未在现有远端引用中发现。原分支被另一工作区使用，保持原样；在 `provider-settings-todos-renumbered` 副本整理后做真实 merge，不重写共享 staging 历史。
- 来源 Todo133 → Todo137（Start Plan GLM-5.3 隐藏视觉标），Todo134 → Todo138（空模型草稿与推理兜底）。同步文件名、标题、索引、交叉引用和测试描述；当前分支原 Todo133～136 不变。
- 三笔整理后提交分别为 `6f8505bf81`、`ee416e47ef`、`2c86f975a8`；对应来源 `1a6a9dcc76`、`284d6a2ba0`、`d3b8b937b1`。提交标题包含新编号，Source-Commit trailer 保留来源追踪；整理前后差异仅为编号及对应引用。
- 正常保留来源已合入 staging 的 Composer recent mode 修复：Renderer 仅持有草稿与最近已接纳输入的偏好，不改变 CLI 队列、模型选择持久化权威或桌面 continuous／手机 replayable 边界。

## 合并交集

- 索引冲突：同时保留 135、136、137、138，顺手校正 135 的过时待实施状态。
- Built-in：两端分别从 22 升到 23，但配置不同。合并结果必须升到 24；同时保留两个普通 API 的 Turbo 默认禁用，以及 Model 通用 disabled/enabled 与 API enabled → high 映射。无 schema 或数据迁移，也不发布线上配置。
- 模型编辑器：保留当前分支的精简／高级布局、隐藏字段及个人覆盖机制，同时接入来源的空 ID 不预填推理档位。复审共用草稿入口和自动合并的浏览器 fixture／用例。
- Header 修复保持；Todo136 仍待实施，本次不顺便扩大签名范围。

## 验证

- 合并版相关 12 个 UI／Provider／桌面 helper 单测文件 284 项通过；Adapter 的新模型 wire 与 Header 合并测试 66 项通过，合计 350 项。日志：`/tmp/provider-settings-merge-tests.log`、`/tmp/provider-settings-merge-wire.log`。
- 设置页浏览器整批 24 项通过：390/中文/浅色、1200/英文/深色，包含 Start 视觉标、空 ID 档位、恢复／取消、高级折叠、隐藏字段保存及个人覆盖。沿用隔离 transport 和本地 Chromium 运行库，无真实用户数据或模型请求；日志 `/tmp/provider-settings-merge-browser.log`。
- 根 `pnpm typecheck`、desktop `typecheck:e2e` 通过；`pnpm lint` 0 错误、42 条既有警告；架构检查 0 违规。日志为 `/tmp/provider-settings-merge-{types,e2e-types,lint,architecture}.log`。
- Composer recent mode 的 pending E2E fixture 校验通过，未晋级；本次未跑完整 Electron／手机 shared-host／Pro 联合实机。行为级单测已覆盖接纳后偏好、拒绝／迟到 ACK、历史与工作区隔离，不能据此宣称原生多端验收完成。
- 三笔整理前后逐文件规范化对比通过：除编号和引用外内容一致；来源 staging 提交保持原历史。无未解决冲突、旧重号链接或删除模块的生产残留导入。
- 双向复审：来源的 Start 视觉标、空草稿、API 映射与 Composer recent 均保留；当前分支的 Header 装配、Turbo 禁用、编辑布局和隐藏字段边界均保留。唯一额外产品文件调整是合并配置 revision 升到 24；未实施 Todo136。
- 状态所有者仍为现有 UI Draft／Recent 与 Provider 配置解析链路，不新增同步、队列或跨层接口。合并相对当前基线约新增 1,320 行、删除 296 行（含文档与测试）；其中整理副本仅机械更号。不扩修无关既有问题，不自动推送。
