# Provider 重构上线收口总计划

> 状态：阶段 A 已完成；阶段 B 自动化实现完成，关键 E2E 等待人工门禁
>
> 最近更新：2026-08-25

## 1. 计划定位

Provider 重构的目标架构和 Todo 00 至 Todo 10 已经完成。本计划不再设计另一套 Provider 架构，也不重新打开已经裁决的问题；它负责把当前大分支从“主体实现完成”推进到“可以作为 Release Candidate 验收”。

后续工作统一归为四类，并按以下顺序推进：

```text
当前 Provider 重构分支
        |
        v
A. 合并最新 staging
        |
        | 形成唯一集成基线
        v
B. 补齐自动化测试与门禁
        |
        | 机器能够持续证明关键链路正确
        v
C. 完成真实环境与发布物验证
        |
        | 证明构建产物、账号和升级路径真实可用
        v
D. 完成工程与文档收尾
        |
        v
Provider Refactor Release Candidate
```

每个阶段开始前再形成该阶段的详细计划、影响面和验证清单。本总计划只固定大方向、阶段边界和完成标准，避免尚未取得运行证据时提前写死具体修复方案。

## 2. 总体原则

1. **以最新 staging 的合并结果作为唯一验收基线。** 当前分支单独通过的结果不能替代最终合并树验证。
2. **保留已经形成的单一 Provider/Model 架构。** 合并和修复不得重新引入旧 Provider Registry、Model Connection Port、ModelRef、Runtime capability map 或按具体模型硬编码的策略。
3. **代码修复继续测试先行。** 新发现的回归先用单测或 E2E 固定场景，再修改生产代码。
4. **自动化验证与真实验证分开。** 单测和类型检查证明静态契约；正式制品、真实账号和真实升级数据证明系统能够上线，二者不能互相替代。
5. **失败必须有明确归属。** 关键测试失败只能被修复，或在最新 staging 上证明为既有基线并形成明确处理结论；不能因为偶发、历史存在或暂时难以复现而静默忽略。
6. **逐阶段收口。** 前一阶段形成稳定结果和证据后再进入下一阶段，避免一边合并 staging、一边修改门禁、一边排查真实账号问题而失去可归因基线。
7. **不扩大重构范围。** Remote Provisioning、普通任务队列、模型选择生命周期、`modelContextBudget.strategy` 和新的产品能力不属于本计划。

## 3. 阶段 A：合并最新 staging

### 目标

把最新 `origin/staging` 的产品改动和基础设施改动吸收到当前分支，形成后续所有测试与真实验证共同使用的集成基线。

### 主要工作

- 更新远端引用并确认双方提交差异。
- 合并最新 staging。
- 对文本冲突逐项按当前 Provider Design 解决，不以简单选择任一侧代替语义判断。
- 复核自动合并但同时被双方修改的协议、鉴权、Session、Trajectory、Telemetry 和 UI 文件。
- 重新扫描已经退役的 Provider/Model 抽象、旧 capability 投影和具体模型 hardcode，确认 staging 没有把旧链路带回生产代码。
- 运行能够快速发现集成破坏的类型检查、定向单测和静态检查。

### 当前已知语义边界

- Host 到 Worker 只同步 Account Provider Config，不能恢复完整 Local Provider Registry 同步。
- staging 新增的 cold-open telemetry 可以保留，但不能借此恢复已经删除的 `modelProviderService` UI 依赖。
- staging 中新增的模型事实必须进入现有 Built-in Provider Config 或 Built-in Model Config Rules，不另建远程或运行时事实源。

### 完成标准

- 最新 staging 已进入当前分支。
- 所有冲突都按设计语义解决并有测试保护。
- 合并工作区干净，快速门禁通过。
- 旧抽象与具体模型 hardcode 仍保持归零。

## 4. 阶段 B：补齐自动化测试与门禁

### 目标

让自动化系统真正覆盖 Provider 重构的核心实现，并且能够阻止 Core、Adapter、Bootstrap 或物理 Built-in Config 回归进入发布流程。

### 主要工作

- 增加直接加载真实 `config/provider/zcode-builtin.json` 的永久测试，遍历验证 Provider 成员、Model Rule 解析和 Effective Model Config 完整性。
- 使用真实 Built-in Config 证明 API Key、Account 与 Request Auth 三条路径能够经 Resolver、Registry、ModelFactory 进入 Adapter。
- 审计普通请求、Compact、Memory、Subagent 与 Off-Peak 对同一 Active Model 的使用，只补确实缺失的测试断点。
- 校验并在人工 review 通过后晋升 Provider 身份、Registry 冷启动、闲时子 Agent 与候选过滤四个关键 E2E。
- 运行 Provider 重构相关包的定向 typecheck、测试与全量回归；环境问题单独记录，不扩展为全仓基础设施改造。

### 完成标准

- Provider 重构核心包的 typecheck 和关键测试可在支持的仓库环境中稳定执行。
- 最新集成树上的关键套件全部通过。
- 所有剩余失败都有可复现证据、明确归属和书面处理结论。
- 物理 Built-in Config 的完整性由永久测试保护，不再依赖人工脚本审计。

## 5. 阶段 C：完成真实环境与发布物验证

### 目标

证明真实发布物、真实账号、真实服务端和真实历史数据能够按新架构工作。

### 验证链路

```text
源码与 Built-in Config
        |
        +--> Desktop 正式制品（macOS / Windows / Linux）
        |
        +--> Standalone CLI / SEA
        |
        +--> Server / Remote bundle
        |
        v
安装与冷启动
        |
        v
真实 Provider / Account / Request Auth
        |
        v
模型请求、错误处理、Usage 与历史数据升级
```

### 主要工作

- 构建并安装 Desktop、Standalone CLI、Server 和 Remote 正式产物。
- 验证所有产物都能定位并加载 `zcode-builtin.json`。
- 使用真实 API Key Provider 验证配置、连通性检查和模型请求。
- 使用真实 Start Plan、Individual、Team 与 Off-Peak 账号验证登录、刷新、退出、账号切换、动态 Request Auth 和服务端拒绝行为。
- 验证普通请求、Compact、Memory、Subagent、闲时任务使用正确的 Provider、Model 和访问上下文。
- 使用真实历史数据库验证 schema migration、历史 Usage 查询以及发布所需的回滚边界。
- 执行 Provider 关键 Desktop/CLI E2E。

### 完成标准

- 支持平台的正式产物均可安装、启动和执行模型请求。
- API Key 与账号类型 Provider 的关键路径通过真实服务端验证。
- 历史数据升级结果正确，发布与回滚边界明确。
- 没有只能在单测 fixture 中成立、在真实部署中无法成立的 Provider 契约。

## 6. 阶段 D：完成工程与文档收尾

### 目标

删除不再具有真实职责的残留结构，使代码、Feature Graph、Design、实施记录和发布结论共同描述同一个已经落地的系统。

### 主要工作

- 清理只包装 ModelFactory、却仍保留人造启动/销毁状态的 Runtime 外壳。
- 清理 `official` 等已经退出 Provider Config 领域的命名残留。
- 更新 Feature Graph 中已删除的符号、调用链和能力来源。
- 将历史 review、roadmap 和 research 中已经失效的“当前事实”明确标成历史证据，避免与已完成状态冲突。
- 修复格式、无用导出、过期注释和其他代码卫生问题。
- 明确 legacy importer 的兼容版本窗口、退出条件和后续删除责任。
- 汇总最终测试、真实验证、已知限制和发布风险，形成 Release Candidate 验收记录。

### 完成标准

- 生产代码中不存在第二套 Provider/Model 业务语义或仅为旧架构保留的生命周期。
- Feature Graph 和当前 Design 与生产代码一致。
- Legacy 边界均有明确存在理由和退出条件。
- 最终提交通过完整发布门禁，工作区干净，发布证据可复核。

## 7. 已确认不作为问题处理的事项

- 当前 Built-in Model Config 没有将 `support_pdf` 或 `support_audio` 设置为 `true`，这是已确认的配置事实，不是本计划的待裁决项。
- legacy `modalities`、`supportsImages`、`supportsPdf`、`supportsVideo` 只允许存在于一次性 importer/reader 边界；只要不重新进入正式 Config、Registry 或 Runtime，就不作为生产双轨。
- Remote Provisioning 与远程设置同步是独立产品能力，不属于本次 Provider Refactor 上线收口。

## 8. 下一步

阶段 A 已按 [`01-staging-integration.md`](./01-staging-integration.md) 完成。阶段 B 的永久测试、Runtime
覆盖审计和全量回归已按 [`02-provider-automation-proof.md`](./02-provider-automation-proof.md) 完成；四个关键
E2E 的 fixture contract 已通过，但仍需人工 review，并在具备 Xvfb 或 Docker 的环境完成正式 replay 与
Docker admission。该门禁完成前不伪装为正式覆盖，也不提前进入阶段 C。
