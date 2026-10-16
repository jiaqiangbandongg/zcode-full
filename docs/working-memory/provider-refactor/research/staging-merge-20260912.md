# Provider 分支合入 staging：2026-09-12

## 目标与边界

- 当前分支 `provider-stabilization-20260911`，合并前 `2fece1a06e`；固定来源 `origin/staging` 的 `75021ca5b5`（8 个新提交）。
- 正常 merge 保留双方历史，不重制来源提交、不使用整文件 ours/theirs；不发布应用或线上 Provider 配置。
- Todo133／141 保持 Draft；不顺便修改请求安全校验、账号同步、数据库迁移、运行中模型或手机恢复协议。

## 来源裁决与双向复审

| 来源 | 行为与处理 | 与本分支交集及结论 |
| --- | --- | --- |
| `6de4b30fa6` | 崩溃归档解析 Crashpad 注解及 V8 OOM 摘要；完整保留 | main 诊断边界，不改变 Provider 或会话状态 |
| `1a01204a8b` | Diff/代码高亮统一使用 WASM 引擎；完整保留 | Worker 与主线程四处入口一致，不修改模型编辑器 |
| `c8b578f771` | 每次超出附件数量弹提示；完整保留 | 与分享默认选择共用 Composer，但附件 scope 和模型/模式草稿相互独立 |
| `ff0f3a5274` | macOS 开发包保留相对符号链接、升级缓存指纹；完整保留 | 不改变正式包、模型配置及数据目录 |
| `df72056924` | 官方 MCP 凭据有效期日志按小时桶去重；完整保留 | 只影响诊断，不改变鉴权与权益判断、模型请求安全校验 |
| `75021ca5b5`、`eb71ba51c2`、`6121d8ba48` | 来源合并提交；保留真实历史 | 文件差异以上述功能组为准，不重复移植 |

无显式冲突、无双方同文件变更；来源 20 文件在候选中原样保留。反向核对：本分支 Header/安全校验、模型编辑器、Start 视觉标、推理空草稿、首次分享默认选择、闲时目录改动均保留。`SessionPane`／`ConversationComposer` 的配置提交与分享 context_refs 链路未被此次 merge 改写。

## MR 影响面补充（impact-only）

- 按功能图 `codeSeeds` 对当前分支完整 diff 反查并读取一跳边：命中模型能力、Provider 设置、分享接续，以及同一 runner 文件中的模型 IO／历史推理节点。
- must-inspect：设置页 → 编辑草稿 → Personal 配置；分享结果 → 独立 Composer 草稿 → 既有 Submission；Builtin → Registry → 闲时 View；执行环境 Header → Model Adapter → 请求安全校验。
- should-inspect：共享模型选择器、Registry 的执行校验、标题／连接测试等公共模型出口。运行时继承、历史消息、队列和 Ticket 不新增替代路径。
- owner／落点：编辑暂存为 UI 草稿，保存仍落 Personal；分享只初始化接收方独立草稿，发送才提交；能力与型号仍由 Registry 发布。手机 shared-host 与桌面 continuous/replayable 交付语义不变。
- 文件命中不是业务依赖：runner 仅传入 defaultHeaders，不据此宣称修改历史推理恢复／Model IO。
- 对账差集：AGENTS 可视化规则与 Todo133／141 草稿仅文档；其他 diff 为上述功能配套 spec、i18n、单测／浏览器 fixture。staging 的诊断／Diff／附件／打包／MCP 日志属于本次整合保留项，不构成 MR 相对 staging 的额外差异。
- 本环境无 Codegraph，未执行自动 callers/impact 查询；采用实际图 seeds、一跳关系、精确调用阅读和测试，不冒充自动全量扫描。
- 图谱漂移：旧 ContextChip 节点／边及部分旧 provider 字段描述仍待单独维护；本分支已在 Todo139 更新分享 surface 的真实 seeds。本次合并不扩修全图。

## 验证

- 合并候选针对性单测：12 文件、126 项通过，涵盖全部来源单测及 Composer 草稿／提交／分享引用、闲时目录与 MCS。
- `pnpm typecheck`：通过。
- `pnpm lint`：通过，42 条既有警告、0 错误。
- `pnpm architecture:check --changed`：合并前后均 0 违规；`git diff --check` 通过。
- 日志：`/tmp/staging-merge-20260912-{unit,typecheck,lint}.log`。
- 既有功能验证沿用 Todo134／135／137／138 与 `todos-136-139-140-review-20260912.md` 的实际证据，不把历史执行写成本轮重跑。
- 本轮未跑原生 Electron、真实 macOS/SSH/手机及线上模型请求。Todo139 的公开分享 → 原生 SessionPane → 首次 RPC 联合验收仍保留；已有 ox-alpha 值域测试基线失败不扩修、不写成全绿。

## 交付

按用户要求提交此次真实 merge，使用 zcode-mr 工作流推送并创建到 staging 的 MR；不自动合入 MR、不修改真实用户配置。

## 推送门禁发现与测试收口

- 强制 pre-push 全量单测出现两项失败。ox-alpha Responses 测试仍要求单个 disabled，与本分支 Todo138 已裁决的通用两档冲突；只对齐断言，并补 enabled 映射为 high 的验证，不修改配置。
- Memory 原地覆盖用例在本文件系统稳定复现：同 inode、同长度的紧邻写入可能保留相同时间戳，fixture 没有确保可观测的文件版本变化。测试在读取开始前将初始 mtime 设为固定旧值，再由原地写入自然更新；仍验证真实 IO 与服务拒绝，不用 sleep，不 mock 掉最终错误。
- Memory 测试及生产实现与 origin/staging 相同。本次仅让测试前置确定；同身份/长度/时间戳内容改动可能无法通过 stat 检出这一既有设计限制仍存在，不宣称已修复、不扩展为正文 hash 或锁机制。
