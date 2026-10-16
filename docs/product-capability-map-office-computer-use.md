# 产品能力图：Office 与 Computer Use 孵化能力

## Feature Summary

| Field            | Value                                                                                                                                                                              |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Developer intent | 在能力图中补充 Office 套件预览/编辑与 Computer Use，并区分当前基础和未来产品化能力                                                                                                 |
| Capability       | Office Suite & Computer Use Incubation                                                                                                                                             |
| Change layer     | presentation                                                                                                                                                                       |
| Operating mode   | planning                                                                                                                                                                           |
| Primary seeds    | `packages/ui/src/PreviewPane.tsx`、`packages/ui/src/components/ui/pdf-viewer.tsx`、`apps/zcode-cli/packages/document-skills-plugin`、`packages/services/src/cua-permission-broker` |
| Out of scope     | 实现 DOCX/XLSX/PPTX 原生编辑器、修改 CUA 权限模型或默认开启 CUA                                                                                                                    |

## Current Fact Versus Roadmap

| Domain       | 当前已有（Current）                                                                                                                                                                                                                                                                  | 孵化/规划（Incubating / Planned）                                          |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| Office 预览  | 工作区文件预览、PDF 分页/缩放预览、DOCX/DOC 与 XLSX 只读预览                                                                                                                                                                                                                         | PPTX 高保真预览、缩略图和跨页导航；Office 原生编辑器仍规划                 |
| Office 编辑  | Agent 可通过官方 DOCX/PDF/PPTX/XLSX Skills 创建、编辑和校验工作区制品                                                                                                                                                                                                                | 原生文档/表格/演示编辑、批注、修订、增量保存和导出                         |
| Computer Use | macOS/Windows 本地默认启用的 CUA Helper、权限引导、屏幕读取、原生输入；模型通过 shared-host `node_repl` 的 `agent.computerUse` SDK 调用，CUA runtime/Helper 状态留在 shared host；macOS PiP session coordinator 由 producer 持有，ZCode 只发布前台 session 与 turn facts；Windows 通过 `computer-use/operation-event` runtime sideband 在 CUA turn 期间显示顶部操作提示，兜底 30 秒 | 暂停/接管、逐步确认，以及 Linux 平台能力                                   |
| 多端/远程    | Desktop 本地 Host 是 CUA 权限主体；工作区文件服务支持 local/remote                                                                                                                                                                                                                   | Web/Mobile 只消费投影或挂载已有 Desktop Host；远端 Computer Use 需独立方案 |

能力图中的“规划”节点表示维护边界和路线图，不表示当前已存在可调用的产品接口。群级 LOC 只统计已落地代码，不给规划能力预填代码量。

## UI Surface Matrix

| User scenario        | UI entry                                                    | Shared implementation                                                | Display/draft owner                                                    | Default/inherit source            | Validation/gating                                             | Commit action                  | Authority/persistence                      | Mode boundary                                                 | Must remain isolated from                                 |
| -------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------- | ------------------------------ | ------------------------------------------ | ------------------------------------------------------------- | --------------------------------------------------------- |
| 预览 Office/PDF 文件 | Workspace File Tree → Preview Pane                          | Preview Pane、PDF Viewer、未来 Office renderer                       | Renderer preview state                                                 | workspace file metadata           | MIME/extension、大小、转换能力                                | 只读打开/翻页/缩放             | Host file/document service；workspace file | Desktop/Web/Mobile UI 可复用；local/remote 服务源不同         | Agent 文档生成和原生编辑提交                              |
| 编辑 Office 文件     | 未来 Office Editor                                          | 未来文档/表格/演示编辑壳                                             | Renderer editor draft                                                  | 当前 workspace 文件版本           | 文件类型、写权限、版本冲突                                    | save/export/comment/revision   | 规划中的 Host Office Document Service      | 必须支持 workspaceIdentity；路径 IO 使用 workspacePath        | CLI Document Skills 的直接工作区执行                      |
| Agent 创建或编辑文档 | Conversation + DOCX/PDF/PPTX/XLSX Skill                     | CLI Skill runtime、内置工具和脚本                                    | Agent turn                                                             | 官方 document-skills plugin       | Skill 启用、依赖可用、工具权限                                | 写入/修改工作区制品            | ZCode CLI tool execution + workspace files | local/SSH/WSL/Docker 在各自 CLI 工作区执行                    | 原生 Office Editor 草稿状态                               |
| 使用 Computer Use    | 通用 `node_repl` 工具结果、CUA 权限引导；Windows 顶部操作提示 | shared-host node_repl runtime、CuaControlPort、Helper、Desktop Main native projection | CLI runtime lifecycle；Host CUA turn tracker；Renderer generic node_repl projection | MCP config + explicit kill switch | macOS/Windows、本地 Host、可信 Helper/broker token 与平台权限 | observe/click/type/open app    | Desktop-local CUA Helper + shared-host CUA runtime | macOS/Windows desktop-local；mobile 走 shared-host attachment | remote host 自建 Helper、其他 MCP/子进程继承 broker token |
| 暂停或人工接管       | 未来 Computer Use control surface                           | 未来 step projection / takeover protocol                             | Renderer control intent                                                | active CUA operation              | 操作阶段、权限、高风险动作                                    | pause/confirm/take over/resume | 尚未定义；能力图只保留规划节点             | Desktop 与 mobile 的控制权语义需另立 spec                     | 普通 conversation stop/permission 语义                    |

## Shared And Divergent Behavior

| Concern              | Shared across surfaces                                  | Deliberately different                                           | Why it matters for this change                     |
| -------------------- | ------------------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------- |
| UI/component         | 复用 Preview Pane、Conversation Timeline 和权限弹窗框架 | Office 编辑器与 Computer Use 控制面板拥有独立草稿/控制状态       | 不能把“能看到 tool card”误写成完整 Computer Use UX |
| Option source        | 文件类型、Skill/MCP contribution 都来自现有 registry    | Office 格式能力与 CUA 平台能力分别判定                           | 一个能力可用不代表另一能力可用                     |
| Commit effect        | 最终都会影响用户可见的工作区或桌面状态                  | Office 保存写文件；CUA 动作改变外部应用                          | 权限、撤销和恢复模型完全不同                       |
| Persistence/recovery | Conversation 只投影工具生命周期                         | Editor draft/version 与 CUA live control 不共用 session 恢复语义 | 未来实现前必须分别定义恢复协议                     |

## Feature Relationships

| Rank           | From                              | Semantic edge                    | To                                            | Condition                                                                                     | Why inspect it                                              | Evidence                                                                          |
| -------------- | --------------------------------- | -------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------- |
| must-inspect   | Office 预览/编辑体验              | reads/writes through             | Host Office Document Service                  | 原生 Office UI 落地时                                                                         | Renderer 不直接持有 Node/LibreOffice 文件 IO                | `IPlatformService` / Host 分层约束                                                |
| must-inspect   | Document Skills                   | produces workspace artifacts for | Office Preview                                | 当前 DOCX/PDF/PPTX/XLSX skill 运行                                                            | Agent 生产和 UI 预览是两个 owner                            | `docs/document-skills-plugin.md`                                                  |
| must-inspect   | Computer Use SDK via node_repl    | executes through                 | shared-host CuaControlPort → Helper/Broker    | macOS/Windows desktop-local                                                                  | 高权限动作必须走签名 Helper 且 fail closed                  | `docs/cua-permission-broker/zcode-cua-permission-broker.md`                       |
| should-inspect | Computer Use lifecycle projection | renders in                       | Conversation Timeline + Windows top indicator | Conversation 使用通用 tool lifecycle；Windows 顶部提示独立消费 `computer-use/operation-event` | 顶部提示只表达 Agent 正在操作，不等于实时画面或可接管工作台 | `packages/ui/src/v4`、`packages/desktop/src/main/windowsCuaOperationIndicator.ts` |
| invariant-only | Remote/Mobile Host                | must not create                  | Desktop CUA Helper                            | SSH/WSL/Docker/mobile remote                                                                  | CUA 授权主体是本机桌面 Helper                               | CUA broker fact spec                                                              |
| invariant-only | CUA broker credential             | must remain isolated from        | other MCP/hooks/Bash                          | 所有 CUA 运行                                                                                 | 防止 confused-deputy                                        | CUA broker fact spec                                                              |

## State Owners And Commit Sinks

| State/fact                      | Draft/display owner            | Authoritative owner                                     | Commit command/service                                           | Persistence/cache                     | Evidence                          |
| ------------------------------- | ------------------------------ | ------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------- | --------------------------------- |
| Preview page/zoom               | Renderer                       | Renderer preview component                              | read-only UI action                                              | ephemeral                             | PDF Viewer                        |
| Office file bytes/version       | Renderer draft（规划）         | Host workspace document service（规划）                 | save/export                                                      | workspace file                        | 分层约束                          |
| Agent document edit             | Conversation projection        | CLI Tool/Skill runtime                                  | Read/Write/Edit/Bash/Skill                                       | workspace file + session event        | document-skills plugin            |
| CUA permission subject          | Permission dialog              | signed Computer Use Helper                                       | request_access / system settings                                 | macOS TCC                             | CUA broker docs                   |
| CUA observation/action          | Generic node_repl projection   | CuaControlPort + Helper broker                          | `agent.computerUse.<tool>` via `mcp__node_repl__js`              | tool result/session event             | CUA broker implementation         |
| Windows CUA operation indicator | Desktop Main native projection | CLI runtime lifecycle + desktop-local Host turn tracker | `computer-use/operation-event` → Host→Main `cua-operation-state` | ephemeral；不进入 snapshot/replayable | `windowsCuaOperationIndicator.ts` |
| macOS CUA PiP session surface | `@zcode/zcode-cua` native presentation | Desktop Main focus router + Host turn fact publisher | typed `pip-session` presentation client | Helper process-local；不进入 snapshot/replayable | producer `PipSessionCoordinator` |
| Human takeover                  | 未来专属 UI                    | 未定义                                                  | 未定义                                                           | 未定义                                | roadmap only                      |

## State And Delivery Boundary

```text
Office
Renderer Office Preview / Editor
          |
          | read / convert / save（Editor backend 规划）
          v
Host File Service + Office Document Service
          |
          v
workspacePath files
          ^
          | DOCX/PDF Skill + CLI tools（当前）
ZCode CLI Document Skills

Computer Use（当前 macOS/Windows desktop-local beta）
Renderer Conversation / Permission UI
          ^
          | ProductProjection / tool lifecycle
ZCode CLI MCP Runtime -- node_repl js / CUA SDK call -->
          |
          | shared-host bridge token + request context
          v
Local Host CUA Broker --> signed ZCode Computer Use.app --> AX / Screen / Input

CLI runtime lifecycle
        -> computer-use/operation-event sideband
        -> desktop-local Host turn tracker
        -> strict Host→Main cua-operation-state
        -> capture-excluded Windows BrowserWindow

sideband 在 legacy delivery 过滤前发送；它不是 `session/event`，不要求
`deliveryKind`/subscription 投影，也不进入 snapshot、replayable 恢复、relay 或
Renderer 状态。

Mobile/Web -- shared-host attachment --> existing Local Host
Remote Host --------------------------X--> create/launch local Computer Use Helper
```

## Must-Preserve Invariants

| Invariant                              | Surfaces/modes                    | Proof needed                                                       | Evidence                       |
| -------------------------------------- | --------------------------------- | ------------------------------------------------------------------ | ------------------------------ |
| 规划节点不冒充已交付功能               | 能力图                            | 节点 scope 明确“当前/规划”，群 LOC 只计算当前代码                  | map data + detail panel        |
| Renderer 不直接拥有 Office 平台 IO     | Desktop/Web/Mobile                | 未来解析/转换/保存通过可注入 Host service                          | architecture spec              |
| Document Skills 与原生 Editor 草稿隔离 | Agent + UI                        | Skill 可独立工作；Editor 取消不撤销 Agent 已提交文件               | document skill boundary        |
| CUA 默认启用且 fail closed             | macOS/Windows Desktop             | 显式关闭或 broker/可信运行时失败时不裸跑 `zcode-cua`               | CUA broker spec/tests          |
| Remote/Mobile 不另起 CUA Helper        | remote/mobile                     | 只允许 shared-host attachment 复用本地 Host                        | web remote + CUA spec          |
| Windows 提示不进入截图或 replayable    | Windows Desktop/Mobile attachment | `setContentProtection(true)`；状态只走 Host→Main ephemeral message | operation indicator spec/tests |

## Codegraph Evidence

当前能力图 worktree 未建立 codegraph 索引，因此本次使用精确 `rg`/文件清单核对当前实现，不对未索引代码声称完整调用图。

| Seed                            | Query               | Direct callers / key path                                                                                        | Depth | Interpretation                                                   |
| ------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------- | ----- | ---------------------------------------------------------------- |
| `PdfViewer` / Office Preview    | file/symbol scan    | Preview Pane → lazy PDF/Office content → file service                                                            | 2     | 当前已有 PDF、DOCX/DOC、XLSX 只读预览；PPTX/native editor 仍规划 |
| `document-skills-plugin`        | package/assets scan | official plugin seed → Skill discovery → scripts/references                                                      | 2     | 当前已有 DOCX/PDF/PPTX/XLSX Agent 生产能力，不是原生编辑器       |
| `createDefaultCuaProductHelper` | focused call scan   | local services → shared-host CUA control port → Helper Host → broker                                             | 2     | CUA 默认启用但仍限 desktop-local，并由显式 kill switch 关闭      |
| `WindowsCuaOperationIndicator`  | focused call scan   | CLI runtime lifecycle → `computer-use/operation-event` → desktop-local Host tracker → Host→Main → native overlay | 4     | Windows 按 Computer Use cell 触发显示只读操作提示，兜底 30 秒；实时画面与接管仍未实现         |

## Graph Drift Candidates

| Candidate               | Live-code evidence                      | Missing/stale graph relation           | Proposed follow-up                                    |
| ----------------------- | --------------------------------------- | -------------------------------------- | ----------------------------------------------------- |
| Document production     | 官方 DOCX/PDF plugin 已默认启用         | Extension Runtime 只有泛化 Skills 节点 | 增加 Document Skills 专项节点                         |
| Computer Use foundation | CUA broker/Helper/AX/Input 已有大量实现 | 现有单个“CUA 权限助手”节点过度压缩     | 拆成 Helper 生命周期、可信 broker、观察和输入执行节点 |
| Native Office UX        | 当前只有 PDF 预览                       | 图中没有路线图边界                     | 新增孵化群，并明确 DOCX/XLSX/PPTX native UX 为规划    |

## Graph Delta

| Status    | Node/edge                                   | Semantic reason                                | Evidence      | Action   |
| --------- | ------------------------------------------- | ---------------------------------------------- | ------------- | -------- |
| confirmed | `capability.office-computer-use-incubation` | 用户要求补充 Office 与 Computer Use 未来能力   | user decision | 更新图谱 |
| confirmed | Office preview/edit roadmap nodes           | 当前 PDF/Skills 与未来 native Office UX 需分开 | code + user   | 更新图谱 |
| confirmed | Computer Use Host/CLI support nodes         | 当前 CUA 实现跨 Host broker 与 CLI MCP         | code/docs     | 更新图谱 |
| confirmed | remote/mobile isolation edges               | 当前 Helper 仅 desktop-local                   | CUA fact spec | 更新图谱 |

## Unresolved Questions

| Question                             | Candidate answers                      | Scope difference                        | Owner                     |
| ------------------------------------ | -------------------------------------- | --------------------------------------- | ------------------------- |
| Office native editor 的解析/渲染内核 | Web/WASM；Host conversion；混合        | 影响 Web 离线能力、远端延迟和文件一致性 | Future Office owner       |
| Computer Use 人工接管协议            | 单 owner lease；逐步确认；只暂停后接管 | 影响多端控制权、恢复与审计              | Future Computer Use owner |
| Linux Computer Use                   | 分平台原生 backend；暂不支持           | 影响权限模型、打包与 E2E 矩阵           | Platform owner            |

## Boundary Decisions

| Boundary  | Decision                                                                                 | Includes                                                                      | Excludes / prunes                                           | Source                                   |
| --------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------- |
| 图中归属  | Renderer 新增孵化体验群，Host/CLI 在现有群补支撑节点                                     | 产品入口、平台底座、Agent runtime                                             | 新建第四个产品运行层                                        | user + architecture                      |
| 当前/未来 | scope 明确标记，LOC 只计当前                                                             | PDF、DOCX/DOC/XLSX Preview、DOCX/PDF/PPTX/XLSX Skills、macOS/Windows CUA beta | 把 PPTX preview 或 Office native editor 写成已完成          | user + code                              |
| CUA 平台  | 本地 macOS/Windows Helper 是当前 product 权限主体；模型经 shared-host `node_repl` SDK 调用；Windows Main 额外投影按 Computer Use cell 触发、30 秒兜底截止的顶部提示 | shared-host attachment                                                        | remote Host 自建 Helper、把提示状态写入 replayable/snapshot | CUA fact spec + operation indicator spec |
| Office IO | 未来服务边界先归 Host Workbench Services                                                 | local/remote 文件、转换、保存                                                 | Renderer 直接 Node/LibreOffice IO                           | architecture                             |

## Accepted Cases

| Case ID        | Setup                     | Action       | Assertions                                                          | Evidence layers | E2E status |
| -------------- | ------------------------- | ------------ | ------------------------------------------------------------------- | --------------- | ---------- |
| DOC-CUA-MAP-01 | 加载能力图                | 搜索 Office  | 找到独立孵化群及文档/表格/演示/编辑节点                             | data + DOM      | automated  |
| DOC-CUA-MAP-02 | 选择 Office 节点          | 查看一阶关系 | 可追踪到 Host document service 与 CLI Document Skills               | data + DOM      | automated  |
| DOC-CUA-MAP-03 | 搜索 Computer Use         | 选择节点     | 可追踪 Renderer UX、Host CUA 和 CLI MCP，scope 显示 current/planned | data + DOM      | automated  |
| DOC-CUA-MAP-04 | Desktop/Mobile、亮/暗主题 | 适应全局视图 | 新群不遮挡、无页面横向溢出                                          | screenshot      | manual     |

## Planning Handoff

| Item             | Destination                                | Status   |
| ---------------- | ------------------------------------------ | -------- |
| Spec update      | `docs/product-capability-map.md`           | complete |
| Case catalog     | 本文 Accepted Cases                        | complete |
| Coverage matrix  | 本文 Accepted Cases                        | complete |
| Decision backlog | 本文 Unresolved Questions                  | complete |
| E2E handoff      | dev-docs data/layout tests + browser smoke | ready    |
