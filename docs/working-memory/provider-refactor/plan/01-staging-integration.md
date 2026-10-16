# 阶段 A：最新 staging 集成计划

> 状态：已完成
>
> 最近更新：2026-08-25
>
> 输入：Provider Refactor `4e8064f8d5`、`origin/staging` `8a7eca86aa`

## 1. 目标

把最新 staging 合入 Provider Refactor，形成后续自动化门禁、真实制品验证和最终收尾共同使用的唯一集成基线。

本阶段只做 staging 语义集成及其直接回归修复，不扩展 Provider 目标设计，不提前实施阶段 B 的 CI 门禁建设，也不进入真实账号和正式制品验证。

## 2. 集成前事实

- 当前 Provider Refactor 相对最新 staging 独有 172 个提交，staging 独有 88 个提交。
- 当前工作区位于 detached HEAD；本地 `provider-refactor-m2` 被另一个 worktree 占用。本阶段不移动或覆盖另一个 worktree 的分支引用。
- 集成前虚拟合并已知存在两个文本冲突：
  - `packages/services/src/zcode-agent/zcodeAgentService.ts`
  - `packages/ui/src/v4/SessionPane.tsx`
- 其余同时修改的协议、鉴权、Session、Trajectory、Telemetry 和 UI 文件即使自动合并，也需要语义复核。

## 3. 不变量

合并后必须继续满足：

1. Host 到 Worker 只同步 Account Provider Config，不恢复完整 Local Provider Registry 同步。
2. Provider/Model 静态事实只来自 ZCode Built-in Config、Account Provider Config、Personal Provider Config、Built-in Model Config Rules 和 Personal Model Config Rules。
3. Core 只通过 ModelFactory/Model 执行模型，不恢复 Model Connection Port、ModelRef、AI SDK 执行 Registry 或 Runtime capability map。
4. 不按具体 modelId 或 Provider 类型在生产代码中推断 reasoning、输入输出格式或其他模型静态能力。
5. staging 的产品行为、协议演进和 telemetry 应保留，但不得以恢复已退役 Provider 依赖为代价。
6. Desktop continuous 与 Web Remote replayable 的既有消息边界不因本次合并改变。

## 4. 已知冲突处理

### 4.1 `zcodeAgentService.ts`

正确结果是组合双方有效语义：

```text
staging cold-open timing / telemetry
                 |
                 v
conversation subscribe
                 |
                 v
ensureAccountProviderConfigSynced
                 |
                 v
Worker 使用自己的 Built-in + Personal 与同步得到的 Account Config
```

- 保留 staging 新增的 cold-open timing 和 telemetry。
- 保留 Provider Refactor 的 `ensureAccountProviderConfigSynced`。
- 不恢复 staging 旧基线中的 `ensureLocalProviderRegistrySynced`。

### 4.2 `SessionPane.tsx`

- 接入 staging 新增的 Platform/open telemetry 行为。
- 保留 Provider Refactor 已删除 `modelProviderService` 的结果。
- UI 不重新取得 Provider Registry 或 Model 运行时事实所有权。

## 5. 自动合并文件复核

对双方同时修改但没有文本冲突的文件，按领域复核：

- Protocol：严格 schema、字段方向和本地/远程调用方是否一致。
- Auth：Account Access 与请求期凭据注入是否保持单链。
- Transcript/Session：cold resume、hydration 和历史恢复是否保持既有时序。
- Trajectory/Usage：继续按实际执行 Model 归因，不回读可变 Session 默认选择。
- UI：staging 新交互不恢复旧 Provider Service、旧 DTO 或第二份模型状态。
- Feature Graph：不得重新登记已经删除的模型抽象为当前生产事实。

## 6. 执行与验证顺序

```text
fetch latest staging
        |
        v
merge --no-ff origin/staging
        |
        v
解决文本冲突 + 复核自动合并文件
        |
        v
先运行冲突相关定向测试
        |
        v
旧符号 / hardcode / Config 双轨扫描
        |
        v
typecheck + lint + affected tests
        |
        v
记录结果并完成 merge commit
```

若合并引入真实行为回归，先增加能够复现问题的测试，再修改生产代码。

## 7. 需要暂停讨论的条件

出现以下任一情况时暂停实施并请求裁决：

- staging 新行为要求恢复完整 Provider Registry 跨进程同步。
- staging 引入新的模型静态事实源、远端模型配置或具体模型 hardcode。
- 合并要求改变 Account、Personal、Built-in 的 Overlay 顺序或职责。
- staging 的协议变更与现有 Active Model、请求期 Access 或模型选择身份契约无法同时成立。
- 修复需要扩大到 Remote Provisioning、普通 Queue 或模型选择生命周期。

普通代码冲突、测试适配和不改变既有设计的兼容修复不构成人工裁决点。

## 8. 完成标准

- 最新 staging 已形成明确 merge commit。
- 两个已知冲突按本计划组合语义解决。
- 自动合并重叠文件完成语义复核。
- 旧 Provider/Model 抽象、能力投影和具体模型 hardcode 保持归零。
- 冲突相关测试、typecheck、lint 和受影响测试通过。
- 阶段执行结果、仍属阶段 B/C/D 的事项和任何既有 baseline 失败已记录。

## 9. 实施结果

2026-08-25 已把 `origin/staging` `8a7eca86aa` 合入 Provider Refactor。实际文本冲突与预审一致，只有：

- `packages/services/src/zcode-agent/zcodeAgentService.ts`
- `packages/ui/src/v4/SessionPane.tsx`

`zcodeAgentService` 保留了 staging 的 session open timing，同时把其旧的完整 Provider Registry 同步替换为唯一允许跨 Host/Worker 边界的 Account Provider Config 顺序屏障。`SessionPane` 保留 staging 的 Platform/session-open telemetry，同时没有恢复已退役的 `modelProviderService`。

自动合并重叠文件已经按 Protocol、Auth、Transcript、Trajectory、UI 和 Feature Graph 分组复核。生产代码扫描没有重新出现：

- `ensureLocalProviderRegistrySynced`
- `ModelConnectionPort` / `ModelConnectionInfo`
- `AiSdkModelRegistry`
- `ZCodeModelRef`
- `ModelInputMediaCapabilities` 或 Runtime capability map
- 按具体模型识别 reasoning 强度或静态格式能力的执行策略

本次集成验证结果：

- 冲突与 session-open telemetry 定向测试：6 个文件、73 项通过。
- CLI Adapter/Bootstrap 重叠文件定向测试：3 个文件、224 项通过。
- 根 `pnpm typecheck` 通过。
- 根 `pnpm lint` 通过，0 个错误；既有 warning 不作为本次集成新增错误处理。
- 根 `pnpm test:unit`：1466 个文件通过、1 个跳过；12416 项通过、25 项跳过。
- `git diff --check` 和本次相关文件的 `oxfmt --check` 通过；同时格式化 staging 新增的 OpenAPI 文件。

仓库级 `pnpm fmt:check` 仍会被既有 `apps/zcode-cli/tests/gb2312.js` 编码文件和 vendored Electron fiddle HTML 的非法标记阻断。本次新增、冲突解决和直接调整的文件均已单独通过格式检查；全仓 formatter baseline 不在阶段 A 修改第三方 fixture 兜底，继续作为阶段 B 的门禁基线问题记录。

### 阶段 B 移交问题

CLI 子工作区的完整 typecheck 尚不能在当前安装状态下形成有效结果。直接运行 Adapter/Bootstrap `tsc` 会先读取旧的依赖 `dist`；按 Turbo 依赖顺序构建时，`@zcode/contracts` 又从根工作区解析到 Zod v4，而该 CLI 包声明并依赖 Zod v3。由此产生的 Plugin、Workflow、Workspace Hook 和 Tool Display 类型错误不是 Provider 冲突路径的失败，而是 CLI 子工作区 install/lock/门禁未闭环的直接证据。

该问题不在阶段 A 修改业务源码兜底。阶段 B 必须先恢复可复现的 CLI workspace 安装和依赖解析，再把 Core、Adapter、Bootstrap 的 build/typecheck/test 纳入自动阻断门禁。

## 10. 后续 staging 恢复范围裁决（2026-09-06）

以下为 2026-09-06 当时裁决；不是当前未决清单。后续替代关系见本节末尾。

当时两组 staging 行为明确不恢复：

1. `SessionPane` 发送前再次同步远程 Provider Registry。当前同步已在远程环境建立、Provider 保存、账号/凭据变化时触发；保存完成后立即发送时存在短暂延迟属于可接受行为，不新增发送前同步屏障。
2. 账号连接变化后自动修正已有 Session 的 Provider/Model。未来可能同时保留多个连接状态，连接变化不等于已有会话模型失效；不恢复 Account-first、首模型兜底或自动切换逻辑。

后续收口：第一项不恢复发送前屏障的边界继续保留；第二项旧事件驱动批量改写没有恢复，但已有选择的有效解析已由 Todo87/96/99 统一实现，不能据此拒绝新架构中的账号对应。不得恢复 Account-first 或首模型兜底；也不能将历史 `Configured Default` 回退当作当前契约。保存意图与有效结果分离、既定提交边界仍有效，多连接方案仅保留 Todo101 Draft。
