# 15 Provider Refactor 统一发布验证

> 状态：已废弃（不再作为独立 Todo）
>
> 日期：2026-08-25
>
> 当前裁决：只集中保存上线前验证范围，暂不执行；不阻塞 Todo 12–14 的结构收口。
>
> 相关计划：[`../plan/plan.md`](../plan/plan.md)、
> [`../plan/02-provider-automation-proof.md`](../plan/02-provider-automation-proof.md)
>
> 相关设计：[`../design/design.md`](../design/design.md)、
> [`../design/registry/configuration.md`](../design/registry/configuration.md)、
> [`../design/registry/runtime.md`](../design/registry/runtime.md)

## 0. 任务定位

本文件保留历史上的发布验证范围记录，但不再作为独立执行入口。当前不为它安排实现或验证；后续若需要上线门禁，
应基于当时的发布流程和最终 staging 基线重新建立专门的 Release Checklist/Todo，而不是恢复本文件。

历史上曾约定验证中若发现问题，按以下规则处理：

1. 既有设计明确、实现不符合：先固定失败测试，再做最小 Bugfix；
2. 设计未定义或真实服务无法满足既有契约：停止验证并请求裁决；
3. 环境、账号或外部服务故障：保存证据并标记 blocker，不把它伪装成产品失败或绿色结果；
4. 未取得真实证据的项目保持 pending，不以类型检查、fixture check 或 mock 结果代替。

## 1. 验证范围

### 1.1 Provider 关键 E2E

以下四条 pending case 保持现状，恢复本 Todo 时再完成人工 review、正式 replay、promotion 和 Docker
admission：

- 同一 modelId、不同 Provider ID/Base URL 的身份隔离；
- Provider Registry 冷启动 prewarm 与首个请求 Endpoint；
- Off-Peak foreground Subagent 的 Provider/Request Auth 继承；
- Provider visibility、Model enabled/完整性过滤，以及 Built-in-wins 重名与顺序投影。

验证顺序固定为：

```text
fixture contract check
        |
        v
pending replay + artifact review
        |
        v
human confirmation
        |
        v
promotion dry-run + apply
        |
        v
case-local replay + default replay
        |
        v
single-spec Docker admission
        |
        v
conversation Docker preset
```

### 1.2 三类真实访问链路

#### API Key

- Personal API Key 和 Endpoint 覆盖最后生效；
- Effective Provider 的 `api.type/baseURL/access` 原样进入 ModelFactory/Adapter；
- 缺少 API Key 的 Provider 不进入可执行 Registry；
- 更新 Config 只影响后来创建的 Model，已创建 Model 保持冻结；
- 请求不回读 Legacy Provider Store 或旧 CLI Config。

#### Account

- Account Built-in Overlay 只处理 ZCode Built-in 声明的账号 Provider；
- Start、Individual、Team Plan 使用结构化 `family/planKind/accessId`，Team Scope 按既有契约补齐；
- 权益接口确实返回模型集合时才覆盖 `builtinModelIds`；未返回时继续使用 Built-in 成员；
- Personal Overlay 继续最后生效；
- 动态凭据按请求解析，不写入 Provider Config，服务端继续承担最终授权裁决。

#### Request Auth

- Config 只保存 `access.type = "request-auth"`；
- Request Auth Source 只作为本次 Model 执行依赖装配；
- 缺少执行期材料时在网络 IO 前返回类型化鉴权错误；
- Request Auth 不进入 Personal Config、Registry View、Session Snapshot、持久化或日志。

#### Reasoning 回放验证

- 验证 DeepSeek Anthropic 续轮使用 canonical reasoning 标准回放；
- 不保留 synthetic empty-thinking、模型 ID hardcode 或 Compatibility Config；
- 若服务端存在独立协议问题，作为新的 Adapter 契约问题重新裁决，不恢复已删除的通用兼容容器。

### 1.3 历史配置与持久化

- 全新安装使用 Built-in + 空 Personal + 当前 Account 正常建立 Registry；
- 旧 `.zcode/v2/config.json` 在同路径迁移前创建内容哈希备份，再原子替换为正式版本化 Personal Config；
- 旧 `model-providers.json` 只作为一次性只读来源，不被修改，也不重新进入稳态 Registry；
- Custom Provider 的明确用户事实完整迁入 Personal；Built-in Provider 只迁移用户显式差异；
- Legacy `modalities` 和已发布平铺能力字段只在 importer 私有边界转换，不进入当前 Config/Runtime；
- Catalog enrichment、Preset、远端静态模型事实和具体模型 hardcode 不被固化成 Personal；
- 迁移、备份、解析或完整性校验失败时保留原文件，不产生半份新配置；
- 已有正式 `schemaVersion` 文件只走相邻版本 migration，不重新进入无版本 Legacy importer；
- 重复启动不重复迁移，旧文件残留不覆盖已经建立的 Personal Config；
- Account Personal Coding Plan Key 的一次性 Credential Store 迁移与 Provider Config 迁移保持职责分离。

### 1.4 发布制品与跨平台启动

- Desktop 开发环境和发布包都能定位 `config/provider/zcode-builtin.json`；
- CLI/TUI/SEA 能从嵌入资产或显式路径物化并读取同一 Built-in Config；
- Server 构建能使用嵌入资产或受支持的显式环境变量启动；
- macOS、Windows、Linux 都使用当前 Environment 的 `.zcode/v2/config.json`，并验证路径、权限、文件锁、
  原子写和 watcher 行为；
- `ZCODE_DATA_BASE_DIR`、测试隔离目录和显式 Built-in/Personal 路径不产生跨 Environment 污染；
- 冷启动、正常重启、配置更新和失败后恢复都得到一致的 Config/Registry 生命周期；
- 打包产物不遗漏 Built-in Config，也不携带真实 API Key 或测试凭据。

### 1.5 最终发布门禁

- Provider、Provider Node、Services、Bootstrap、Core、Adapters、Shared、Desktop/UI 定向测试；
- 根 `pnpm typecheck`、`pnpm lint`、`pnpm fmt:check` 和 `pnpm test:unit`；
- 受影响发布构建与平台 smoke；
- 已晋升 E2E 的正式 replay 和 Docker suite；
- Legacy/Hardcode/第二事实源机械归零检查；
- Release Candidate 记录汇总提交、环境、命令、artifact、已知限制和 blocker。

## 2. 等价性口径

“全新安装与历史升级一致”不表示二者无条件产生完全相同的配置。历史用户可能拥有 API Key、自定义
Provider、自定义模型和显式覆盖。正确口径是：

> 在 Built-in 版本、账号状态和用户显式意图相同的前提下，直接写入当前 Personal Config 与从已发布旧
> 配置迁移得到的 Personal Config，应解析出等价的 Effective Provider/Model，并形成等价的请求装配。

迁移只保留旧文件明确表达且归属于用户的事实，不追求复制旧系统曾经通过 Catalog、Preset、远端同步或
模型名 hardcode 推导出的偶然 Effective Snapshot。

## 3. 与其他 Todo 的关系

```text
Todo 12：Selection 最终校验归位
        |
        v
Todo 13：目标 Host / Environment 选择权威
        |
        v
Todo 14：Factory、MCS、Legacy DTO 和死代码机械归零
        |
        v
Todo 15：统一真实验证与发布证据（历史草案，已废弃）
```

- Todo 11 仍是独立草案；是否实施需要另行裁决，不由本验证 Todo 偷偷决定；
- 本节只保留当时的阶段关系，不能作为当前执行顺序或验收承诺；
- Todo 12–14 的单元测试和机械验收已经分别收口；
- 后续发布验证不恢复本文件，改由最终 Release Checklist 按当时基线定义。

## 4. 明确排除

- Remote Provisioning、远程设置编辑与配置同步；
- 新的 Provider/Model 产品能力或 Access Type；
- `modelContextBudget.strategy` 等 Agent 参数；
- 修改 Account 套餐、权益接口或服务端鉴权产品语义；
- Queue、Goal、Background、恢复状态机或 mobile replayable 新设计；
- 改变已经确认的 PDF/Audio Built-in 配置事实；
- 为了让验证通过而恢复 Legacy Catalog、Preset、远端模型事实或具体模型运行时 hardcode。

## 5. 恢复执行条件

只有满足以下条件后，才把本 Todo 从“Draft”改为“待执行”：

1. Todo 12–14 已完成，或已明确本次发布不包含其中某项并记录风险；
2. 待上线分支已经合入目标 staging 基线，结构改动进入冻结期；
3. Desktop 图形环境、Docker daemon、平台构建机和必要测试账号/凭据可用；
4. 四条 pending E2E 的人工 review 人员和 artifact 保存位置明确；
5. 真实服务验证使用的账号、额度、环境和脱敏日志规则已确认；
6. 验证失败的 Bugfix 与设计裁决流程有人负责，不在结果出来后临时改变口径。

## 6. 完成定义

1. 三类 Access 均有真实或等价隔离环境的请求证据；
2. 全新安装、历史升级、重启和配置更新均有可复核结果；
3. Desktop、CLI/TUI/SEA、Server 与目标平台发布制品能够装载同一份 Provider/Model 事实；
4. 四条 Provider E2E 完成人工确认、正式 replay 和约定的 Docker admission；
5. 完整发布门禁通过，所有失败都有明确归因；
6. 没有把环境问题、pending case 或未执行项目写成绿色；
7. Release Candidate 验收记录能够支持上线、回滚和后续删除 Legacy importer 的决策。
