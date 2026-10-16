# Provider 重构 Working Memory

> 状态：主体实现收口，进入整体验证
>
> 最近更新：2026-09-09
>
> 当前阶段：核心架构和设置边界已落地；整理 Design V2 与上线验证

本目录保存 Provider 重构的目标设计、分阶段实施和当前代码调研。它是本次宏观工作的持续记忆。

## 文档入口

```text
provider-refactor/
├─ provider-refactor.md
│  └─ 当前状态与总入口
│
├─ design/
│  └─ design.md
│     └─ 历史演进中的层次化设计树
│
├─ design-v2/
│  ├─ design.md
│  │  └─ 当前核心设计唯一入口
│  └─ evidence-and-contradictions.md
│     └─ 历史矛盾、证据与裁定
│
├─ steps/
│  └─ steps.md
│     └─ 迁移路线、实施目标、结果和问题
│
├─ plan/
│  └─ plan.md
│     └─ 合并、自动化门禁、真实验证与最终收尾的上线总计划
│
├─ research/
│  └─ research.md
│     └─ 当前代码与协议的专项调研
```

- [`design-v2/design.md`](./design-v2/design.md) 是当前核心设计唯一入口。
- [`design-v2/evidence-and-contradictions.md`](./design-v2/evidence-and-contradictions.md) 说明旧材料如何被取代、
  当前事实依据和仍未完成的事项。
- [`design/design.md`](./design/design.md) 保留演进过程中的层次化设计，发生冲突时不再覆盖 Design V2。
- [`steps/steps.md`](./steps/steps.md) 介绍迁移 Roadmap、M1-M3 实施记录和 M4 阶段设计与实施结果。
- [`plan/plan.md`](./plan/plan.md) 固定 Provider 重构进入 Release Candidate 前的四阶段上线收口方向。
- [`research/research.md`](./research/research.md) 介绍当前代码和协议的专项调研，并引用每篇事实文档。

## 当前阶段

- [Todo156：Start 独立 Provider 后续修复与最终页面决策](./steps/todo-156-start-plan-followup-final-decisions.md)：**已实施并自审，用户已要求提交推送；保留基线失败记录**。本条维护 Start 常驻、状态复用、连接依赖修复、领取流程、团队下拉、套餐标签、副屏首条推荐，以及推荐余额共享／按需刷新／60 秒有效期的最终范围；团队数据构造治理延期，多实例额度卡保持基线，实施与验证证据、未覆盖项见本条 §14。

- [Todo155：Start 连接依赖清理与模型切换套餐标识](./steps/todo-155-start-plan-selection-dependency-cleanup.md)：初版调查归档，后续最终决策见 [Todo156](./steps/todo-156-start-plan-followup-final-decisions.md)。

- [Todo138：空模型草稿与 Model 层推理档位兜底](./steps/todo-138-reasoning-level-ui-and-api-defaults.md)：已完成；空 UI 草稿不预填档位，Model 通用兜底 disabled/enabled，三种 API 通用 map 将 enabled 转为 high；保留层级及专用规则。来源 revision 23，合并版为 24；验证见正文及合并记录。

- [Todo137：体验套餐 GLM-5.3 隐藏视觉标](./steps/todo-137-start-plan-glm53-vision-badge.md)：已实现并通过展示回归；仅扩充共用展示范围，保留图片能力及 Flash 标识。

M1 已经统一所有生产模型调用的 `Model` / `ModelRequest` 边界。M2 已经统一普通长期 Model 的来源：

```text
ProviderConfigService
├─ ZCode Built-in Provider Config
├─ Account Provider Config
└─ Personal Provider Config ────────────────┐
                                            ├─> Effective Provider Config
ZCode Built-in Model Config Rules ──────────┤
Personal Model Config Rules ────────────────┘
                             |
                             v
            ProviderRegistryService
                     ├─ Provider[] / { modelId, config: ModelConfig }[]
                     └─ createModel(selection)
                                  |
                                  v
                             ModelFactory
                                  |
                                  v
                                Model
                                  |
                                  v
                           ModelRequest
```

Config Overlay、Registry View、Settings/Selection Facade、ModelFactory 和 Account Provider 请求期鉴权已经进入生产链路。Account Config 使用独立进程协议同步给本地 Worker，不再从 Workspace Registry Snapshot 反向提取；旧 Provider Store 只承担一次性 Personal/Account 迁移输入。

M3 已在这套基础上完成模型选择、原子 Submission、Guide/立即、Provider 设置页与 Model 输入输出格式
收口，并删除被取代的 ModelRef、共享可变 Runtime 模型状态、媒体 capability map 与连通性旁路。

M4 已按既定设计完成实现：hidden Provider 仍是 Registry 中的完整 Provider，可见性只过滤设置页和模型选择器；
智谱账号 Provider 以 `zhipu-account + family + mode` 声明静态访问方式，并在请求期取得动态鉴权；闲时任务使用
同一 Registry、ModelFactory 和 Model，不修改或恢复 Session Selection。阶段过程见
[`steps/04-model-execution-cutover.md`](./steps/04-model-execution-cutover.md)；其中的阶段性 `request-auth`
术语已被 Todo 26 取代，现行契约以 Design V2 为准。

## 当前进度

| 阶段     | 主题                                  | 状态                            |
| -------- | ------------------------------------- | ------------------------------- |
| M0       | 宏观架构与现状地图                    | 已完成第一轮                    |
| M1       | Model 与 ModelRequest                 | 已完成，MR !2006 已合入 staging |
| M2       | Provider 配置、Registry 与 Model 创建 | 已完成，作为 M3 的基础切片      |
| M3       | Provider 架构切换与 Model 格式收口    | 已完成                          |
| M4       | 模型执行链、闲时任务与 Subagent       | 已完成                          |
| 后续收口 | Config 发布、Account 与 Settings 边界 | 主体已实现；剩余项见 Design V2  |
| 独立专题 | Environment 配置与 Provisioning       | 不属于本次 Provider Refactor    |

## 下一步

[Todo154：Start 独立 Provider 与提交时体验套餐推荐](./steps/todo-154-start-plan-independent-provider.md)：**已实施并 review，Pro E2E 通过**。保留两家 ID、统一名称和品牌图标，Start 免连接并与付费套餐并存；不迁移选择数据，增加提交／创建时同模型且思考兼容的额度推荐，统一持久化“不再提示”。已明确 Subagent 纳入、立即运行／Bot／后台执行排除及付费失效通知边界；详见本条 §8；实施前事实归 research，最终行为已同步正式 Start 规格，不启动 Todo101。

[Todo117](./steps/todo-117-preserve-account-domain-on-provider-save.md)／[Todo118](./steps/todo-118-preserve-legacy-provider-enabled.md)：最新裁决已确认，待实施。内置账号 Provider 取消禁用能力，已有账号 false 不再生效、旧账号禁用不迁入；手动 Key Provider 保留启停。公共连接、权益、凭据和模型可执行性判断不变，不再等待内置禁用来源裁决。

[Todo132：模型选项底色反馈与供应商名称编辑修复](./steps/todo-132-model-option-feedback-and-provider-name-edit.md)：**待执行，方案已确认**。方块选项只加强选中底色，文字/图标及覆盖边框不改；名称输入不定时保存，Enter/失焦确认、Esc 放弃，其他字段保存不能夹带未确认名称。已列局部边界与验证，本轮仅落盘。

[Todo131：模型设置页智能配置位置与“恢复”按钮](./steps/todo-131-model-settings-smart-config-placement-and-restore.md)：**待执行，方案已确认**。智能配置移到模型 ID 容器右侧，底部左侧增加“恢复”；只改草稿、保存后生效，空 ID 可用且仅 saving 禁用。关联 Todo125/130，包含响应式布局、异步保护和 R121 验证，本轮仅落盘。

[Todo130：智能配置开关与手动配置字段边界修正](./steps/todo-130-manual-model-config-editable-field-boundary.md)：**待执行，方案已确认**。开关仅保存中禁用；手动只固化可编辑字段，内部映射/能力继续由当前系统规则解析，修 schema、合成与保存回退。按预计未正式发布处理，兼容保持轻量；不加隐藏字段编辑器，本轮仅落盘。

[Todo129：Provider 埋点适配与 Team 套餐识别修复](./steps/todo-129-provider-telemetry-compatibility-and-team-classification.md)：**待执行，方向已确认**。报表不动，埋点侧最大努力恢复旧 ID；按旧版逐事件核实，能确定的直接实施，少数无法还原项留证而不阻塞整体。修两家 Team 识别、首页闲时误拦、BigModel 漏斗与成功标签；不动真实 Provider 身份、请求、存储或旧 parser，本轮仅落盘。

[Todo128：Provider 启动契约与闲时资格刷新修复](./steps/todo-128-provider-start-contract-and-offpeak-eligibility.md)：**待执行，方案已确认**。统一启动只等待就绪、显式读取当前快照；修复闲时资格更新完成后的通知、手动刷新和乱序覆盖。包含 Air 证据、全部返回值消费点及验证要求；不展开 Todo11 外壳重构，不改 Composer，本轮仅落盘。

[Todo127：Built-in 配置在线发布与更新链路修复](./steps/todo-127-builtin-online-release.md)：**待执行，详细方案已确认**。已落盘下载 20 秒／10 MB、每分钟到期检查与每小时正常下载、Account 对齐和同一检查入口驱动恢复，以及实施顺序和测试。调查证据独立留档，本轮不实施产品代码。

[Todo113：近期新模型目录与智能配置更新](./steps/todo-113-new-model-catalog-refresh.md)：**第二轮待执行**。已列明逐模板目录与配置改动、下线清理及聚合支持必查；已确定型号仍须深度研究，不确定细节在执行时核实。首批历史结果保留，不与本轮验收混算。

[Todo126：GLM 视觉标展示、Flash PDF 与 Coding Plan API Turbo 默认配置](./steps/todo-126-glm-flash-pdf-and-coding-plan-turbo-defaults.md)：已确认并落盘，待实施。调整 Flash 的通用 PDF 声明和两个套餐 API 模板的 Turbo 默认值；追加设置页和模型选择菜单隐藏 Coding Plan GLM-5.3 视觉标的展示例外，保留桥接图片能力与 Flash 视觉标。

[Todo125：模型设置页问号说明与定稿文案](./steps/todo-125-model-settings-help-copy.md)：已完成产品裁决并落盘，待实施。固定中文定稿、标题问号与跨端交互；不得擅自润色、扩充提示或改变配置行为。

[Todo114](./steps/todo-114-account-status-sync-and-key-retry.md)（上游原 Todo105）：已合并并补齐 Account 原因同步、统一 Z.ai/BigModel 缺 Key 分类、将个人套餐获取失败操作改为重试。上游 280 条定向测试与四组组件浏览器通过；完整 App / 手机链路剩余验证归 Todo102，具体证据见 Todo114。

上线前 Schema 专项裁决见 [Todo104](./steps/todo-104-pre-release-schema-review.md)（m2 原 Todo99）：核心方案及默认选择合并保持；Session 新增 modelSelection 并保留旧值，Off-Peak / Wiki 保存局部修复待实施。6.19 已收紧为本 Todo 要改的 13 项配套内容并获认可。Subagent Markdown 的原字段迁移是 Todo97 已裁决的可读性取舍，不在本 Todo 重开。2026-09-10 用户已授权实施，完成状态以实施账本为准。

M2/M3 已经让普通 Provider 的配置、展示、选择与执行统一使用 Built-in → Account → Personal 三层 Config、
Built-in + Personal Model Rules 和进程级 Registry。完成情况见
[`steps/02-provider-config-and-registry-cleanup.md`](./steps/02-provider-config-and-registry-cleanup.md) 与
[`steps/03-provider-architecture-cutover-implementation-log.md`](./steps/03-provider-architecture-cutover-implementation-log.md)。

核心架构与后续已完成 Todo 已形成当前上线收口基线；Todo 32 已完成 Team/Individual 设置页与
Effective Provider 边界收口。Todo 11、11A、15、19、22 等未完成、延后和草案事项统一见
[`design-v2/design.md`](./design-v2/design.md#11-尚未完成但不改变设计的工作)，不再从旧阶段编号推断当前状态。

本轮上线收口不扩大到 Remote Provisioning、模型选择生命周期、普通 Queue、
`modelContextBudget.strategy` 或账号产品重构。

## 维护原则

```text
design-v2 最终系统如何工作，以及历史矛盾如何裁定
design    历史层次化设计与专题细节
steps     如何迁移，以及实际发生了什么
plan      已完成主体实现如何进入可发布状态
research  当前代码和协议事实
```

稳定结论进入 design-v2；实施过程和偏差进入 steps；事实证据进入 research。旧材料不再通过静默改写伪装成
最终设计，冲突统一记录在 Design V2 的考证文档中。

Provider 架构演进期间，设计、实施记录、调研和历史材料统一保存在本 Working Memory 中，不提前复制到正式 `docs` 文档。相应阶段完成实现、验证并形成稳定事实后，再从 Working Memory 提炼面向长期维护者的正式文档；正式文档描述已经落地的系统，Working Memory 保留演进过程和决策依据。
