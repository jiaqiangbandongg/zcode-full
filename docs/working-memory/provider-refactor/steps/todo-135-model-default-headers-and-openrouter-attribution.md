# Todo135：恢复模型请求默认 Header 与 OpenRouter 归因

状态：**2026-09-12 实现、逐项复审及本地验证完成；未执行真实桌面/手机/SSH 联合实机验收，未向外部模型服务发请求。**

### 实施契约（2026-09-12）

- Bootstrap 复用 `buildCliZCodeSourceHeaders` 构造执行环境的 `defaultHeaders`，通过现有 Execution Config → Model Adapter → Model Execution 传递；不读取 Provider Registry 来推断运行环境。
- Model Execution 在绑定 Model 时，按本次 Provider Base URL 合入既有 OpenRouter 默认归因，再合入用户 Header；默认配置、Provider 配置和已绑定 Model 均不被后续合并原地修改。
- Header 合并复用同一个大小写不敏感的覆盖函数；请求期鉴权继续最后覆盖其负责的 Header，不改变请求安全校验、追踪和运行时刷新职责。
- 当前 Desktop 本地通过 `ZCODE_APP_VERSION` 注入客户端版本；远程启动命令同样传递该变量；协议入口显式传入 `sourceTitle: electron`。继续保留环境变量优先于 Worker 自身版本的行为，独立 CLI 使用既有版本与来源装配。
- 不引入状态同步、缓存、IO、协议或持久化变化；desktop continuous / mobile replayable 仍由原链路负责。标题、Wiki、子任务和连接测试通过公共模型工厂消费，不新增业务侧补头。

## 目标与根因

恢复 Provider 重构时漏接的两项行为：实际模型请求的通用默认 Header，以及 OpenRouter 专用归因 Header。标题生成是已反馈的入口，但不能仅给标题生成打补丁。

对照基线：`origin/main` 的 `e7921fb5d484d9c9d22d2e638064163fd13143a6`；调查代码：`d9b071cdae`。

- 旧 `createDefaultProviderHeaders()` 在构造 Provider 时合入来源信息与站点归因，再允许用户 Header 覆盖。
- 当前 `model-execution.ts` 的 `toAiSdkProviderConfig()` 只复制 `config.api.headers`，公共模型请求缺少默认来源信息。
- 来源构造器仍在，业务 `NodeApiClient`、安全校验开关查询和路由配置查询也有注入，但实际模型 SDK 请求不经过这些业务出口，不能视作等价替代。
- `withOpenRouterAttributionHeaders()` 仍在，但当前 CLI 来源构造器传入 `undefined`，不会匹配 OpenRouter。
- 账号鉴权、自定义 Header、请求安全校验、请求追踪已有独立实现，并未整体丢失。安全校验成功时的 `X-Client-Version` 不能替代所有模型请求的客户端版本声明。

## 修复要求

### 1. 通用默认 Header

复用现有来源构造能力，通过执行环境装配接入公共模型请求边界，不恢复旧 Registry，也不在标题、Wiki、Subagent 等业务中分别补头。

| 类别 | 恢复的默认内容 |
| --- | --- |
| 客户端版本 | `User-Agent: ZCode/<version>`、有效版本对应的 `X-ZCode-App-Version` |
| 产品来源 | `HTTP-Referer`、`X-Title: Z Code@electron/cli`、`X-ZCode-Agent: glm` |
| 环境 | `X-Release-Channel`、`X-Client-Language`、`X-Client-Timezone` |
| 平台 | `X-Platform`、`X-Os-Category`、`X-Os-Version` |

- 保留显式客户端版本、来源和环境的装配关系，不能把 SDK 版本或远端 Worker 自己的版本误当桌面客户端版本；审查本地、远程 Worker 和独立 CLI 的现有来源传递。
- 保留原有取值规范化与缺失值语义，不把非法换行等写入 Header；正常版本已提供时必须实际发出，不能静默变成 `unknown`。
- 不将运行环境 Header 写进 Built-in／Personal 配置，不新增数据迁移。

### 2. OpenRouter 归因

- 复用已有 URL 匹配与归因工具，传入实际配置的 Provider Base URL，不能按显示名称或 Provider ID 猜测。
- 命中时默认补 `X-OpenRouter-Title: ZCode`、`X-OpenRouter-Categories: programming-app`；非 OpenRouter 不补。
- 保留现有 HTTPS、域名及子域边界，不扩大到名称相似的站点。

### 3. 保持现有组合边界

```text
运行环境 → 通用默认 Header + 站点默认归因
                              ↓
                      Provider 用户 Header 覆盖
                              ↓
                 现有请求鉴权 / 追踪 / 安全校验处理
                              ↓
                       SDK 最终网络请求
```

- 默认来源和站点 Header 允许用户显式覆盖；合并须遵守 HTTP 头名大小写不敏感语义，不产生重复拼接。
- 不改变现有鉴权、请求安全校验和请求归属的权威关系、执行顺序及降级规则；不另造一套机制。
- 共享构造器支持的 `X-Device-Mid` 不属于此次恢复范围，不因复用顺手发送给第三方模型服务。
- 不改账号状态同步、模型选择、UI、请求正文或桌面 continuous／手机 replayable 语义；手机仍复用 shared-host 执行链。

## 实施与验收清单

- [x] 先补能复现漏接的最终网络请求测试，再实现；不能只断言 helper 返回值或安全校验配置对象。
- [x] 在公共模型出口覆盖 `generateText` / 流式请求及三种 API 格式；覆盖普通 API Key、账号路径和安全校验关闭／降级，确认默认版本声明不依赖安全校验成功。
- [x] 以标题生成作重点回归；审查主会话、显式／继承 Subagent、Wiki、连接测试等入口是否同走修复后的出口，旁路如存在需接入或明确记录，不逐业务复制。
- [x] 覆盖 OpenRouter 命中／不命中、自定义 Header 大小写覆盖、缺失／非法环境值；确认既有鉴权、追踪 Header 与请求内容不回退。
- [x] 对照桌面本地、远程 Worker、独立 CLI 的来源装配，验证客户端版本与来源正确；真实环境未测项如实标注。
- [x] 合并执行相关单测、类型检查、lint 和架构检查；以注入 transport／本地服务捕获真实 SDK 请求，不用构造器测试代替 wire 断言。不必每个小改动跑大规模桌面回归。
- [x] 完成后按上述两项目标逐条 review，确认无遗漏、无重复实现、无额外身份字段扩散，再提交实现及证据。

## 实施结果与完成后复审

- 基线：`27eba110b4`；执行前 freshness、架构检查通过；重新 fetch 的 `origin/main` 仍为 `e7921fb5d4`。
- 通用 Header：现有来源构造器通过 `defaultHeaders` 进入公共 Model Execution。未另造来源构造器，也没有把 Header 写进 Registry / Built-in / Personal。
- OpenRouter：删除 Bootstrap 中传 `undefined` 的无效归因调用；绑定模型时按实际 Base URL 复用原匹配器。测试包括官方域名、子域、伪后缀及非 HTTPS。
- 合并：提取原请求鉴权的大小写不敏感覆盖算法，供默认值、用户值、请求鉴权共用；后者优先级不变。构造和请求使用副本，旧 Model 不随新 Provider 配置变化，不串请求鉴权。
- 调用链复审：生产 `new AiSdkModelAdapter` 仅在 Bootstrap `model-factory.ts`，由 `create-app.ts` 装配；主会话与子 Runtime 复用该工厂。标题 sidecar 使用 `createRuntimeModel`；Wiki 和连接测试经 session facade → workspace runtime → 同一工厂。未发现需业务侧单独补头的生产旁路；调用方显式注入的替代 ModelAdapter 仍由调用方负责。
- 标题专项：真实 `AgentRuntime.maybeStartSessionTitleGenerationFromExternalInput` → sidecar → Model → 实际 SDK → 注入 fetch 捕获，断言原标题 Prompt、标题写回、版本、other 类型、Session/Trace Header；并非只复刻一段标题 Prompt。
- 版本归属：桌面 `desktopRuntimeEnv.ts` 注入版本，SSH `remote/connect.ts` 传递版本，协议入口显式 electron，独立 CLI 使用原来源检测。测试确认客户端环境版本优先于 Worker 版本；操作系统信息仍表示实际执行机器，与 main 一致。
- 架构：沿原 Bootstrap → Adapter 边界传递基础设施配置。模块为 legacy/unmanaged `zcode-cli`，无新增模块、状态 owner、缓存、通知或协议；不影响 continuous/replayable 的事件顺序与恢复语义。
- 未触及：真实账号、用户配置、数据库、模型选择、请求正文、安全校验和降级策略。没有额外注入 `X-Device-Mid`。

### 验证证据

| 范围 | 结果 | 本地日志 |
| --- | --- | --- |
| Bootstrap wire、来源装配、Registry、runtime headers | 6 文件 39 项通过；含新增 20 项最终请求测试 | `/tmp/todo135-bootstrap-tests.log` |
| Adapter Header、鉴权与绑定、模型请求 | 5 文件 55 项通过；含新增 2 项合并/绑定测试 | `/tmp/todo135-adapters-tests.log` |
| 既有手动 Coding Plan 安全校验及端点路由 | 2 文件 47 项通过 | `/tmp/todo135-signing-tests.log` |
| Desktop 环境、远程启动命令、OpenRouter 匹配 | 3 文件 43 项通过，4 项 macOS 专属用例在 Linux 跳过 | `/tmp/todo135-source-tests.log` |
| 根类型、Bootstrap 类型、Adapter 构建 | 通过 | `/tmp/todo135-typecheck.log`、`/tmp/todo135-bootstrap-typecheck.log`、`/tmp/todo135-adapters-build.log` |
| 新增/修改测试独立严格类型检查 | 通过，使用 NodeNext / ES2023 / strict | `/tmp/todo135-test-types.log`、`/tmp/todo135-adapter-test-types.log` |
| 根 lint、CLI 改动文件 lint、架构 | 根 0 errors / 42 既有 warnings；CLI 7 文件 0 warnings/errors；架构 0 violations | `/tmp/todo135-lint.log`、`/tmp/todo135-cli-lint.log`、`/tmp/todo135-architecture.log` |

根 lint 默认排除 CLI，因此额外以临时配置保留同等 max-lines 和测试例外规则，对 CLI 改动文件实际检查；没有改仓库 lint 配置。Bootstrap 测试使用 Adapter 的包导出，先构建 Adapter，避免拿旧 dist 当作当前代码验证。

先写的 wire 测试在旧实现上确认缺少 ZCode 版本及 OpenRouter Header；随后完善账号鉴权 fixture 和流响应，再完成回归。安全校验测试使用不同假 Key 隔离进程级开关缓存，不重置生产缓存或访问真实服务。首次绑定测试直接改 Registry 冻结配置被正确拒绝，已调整为创建新配置再绑定，不放松冻结保护。

实机限制：本次没有运行真实 Electron、手机 shared-host、SSH 工作区模型请求或 Windows/macOS 全机验证。环境传递用例与注入网络传输的 SDK 请求证明代码链路，不替代这些实机证据。

本项不授权发布线上配置、修改真实用户数据或自动推送；实现与记录提交在当前工作分支。
