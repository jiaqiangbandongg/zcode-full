# Todo 47：Provider 连接测试保存时序与结果契约清理

> 状态：已完成
>
> 日期：2026-08-31
>
> 来源：Provider 设置页连接测试链路 Review

## 1. 问题

Provider 设置页在连接测试前主动保存当前 Provider 草稿，用来避免 idle/blur 自动保存与测试并发。这个产品意图
正确，但当前实现同时使用 `savePersonalModelConfig` / `deletePersonalModelConfig` 重写模型 Personal Rule：

```text
测试连接
   |
   +--> 保存 Provider 草稿
   +--> 用 Renderer 模型快照重写/删除 Model Rule
   `--> 刷新 Worker Registry 后测试正式 Model
```

正式模型编辑已经使用带 Settings revision 校验的原子 `savePersonalModelDraft`。旧的两条 Model Config 写接口绕过
revision 校验，可能用过期 Renderer 快照覆盖较新的 Personal Rule，也形成第二套模型保存协议。

连接测试结果还保留两层无效抽象：

- Services 根据 HTTP 状态、错误文案和嵌套 `cause/data` 维护第二套错误分类，但 UI 只消费错误消息；
- UI 把单次正式 Model 测试再次投影成 `ModelConnectivitySummary`，并保留已删除的多 Endpoint
  `noEndpointResult` 分支。

## 2. 已确认边界

### 2.1 测试前仍然主动完成保存

不能把修复简化成“直接测试”。Provider 输入框可能仍停留在 UI debounce 中，尚未进入 Service 的 Provider
operation queue；只等待已有 operation 不能覆盖这段窗口。

目标时序：

```text
当前 Provider 输入草稿
          |
          v
取消/消费同一个 idle debounce
          |
          v
复用 blur/idle 的唯一 Provider Draft Commit
          |
          v
等待该 Provider 保存队列完成
          |
          v
Worker 刷新正式 Registry
          |
          v
按 providerId/modelId 创建并测试正式 Model
```

- 只有确实存在未提交 Provider 草稿时才新增一次保存；
- 连接测试不得自行重写 Model Config；
- 如果未来从模型编辑弹窗发起测试，弹窗必须先完成自己的原子 `savePersonalModelDraft`，不能恢复旧接口；
- Personal Config、Registry 与正式 Model 继续是唯一配置及执行权威，不创建测试专用 Provider/Model。

### 2.2 旧 Model Config 写接口彻底退出

删除 `savePersonalModelConfig` 和 `deletePersonalModelConfig` 的上层公共入口与转发，包括：

- `IProviderSettingsService`；
- `ProviderSettingsFacade`；
- `ProviderSettingsMutationTarget`；
- Provider Runtime / Config Runtime 的公共转发；
- UI hook、连接测试 helper、mock 与旧接口测试。

模型编辑统一使用 `savePersonalModelDraft`。底层 exact Personal Rule 的增删改只作为该原子操作内部实现，不再暴露
为可被 UI/Services 任意调用的第二套协议。

### 2.3 连接结果只保留真实消息

当前 UI 没有错误类别交互，本轮删除 Services 的 `auth`、`model_not_found`、`rate_limit`、`network`、
`server`、`unknown` 猜测与 HTTP status 深层搜索。结果契约收口为：

```ts
type ModelConnectivityResult = { success: true } | { success: false; error: { message: string } };
```

未来若产品需要按错误类型展示不同操作，必须复用正式 Model/Adapter 的结构化错误，不在 Provider Settings 中再次
根据字符串分类。

### 2.4 删除旧多 Endpoint UI 投影

删除 `ModelConnectivitySummary`、`resolveModelConnectivitySummary`、`noEndpointResult` 与相应旧测试。组件直接消费
`ModelConnectivityResult`，成功显示模型身份，失败显示正式执行链返回的错误消息。

### 2.5 本 Todo 不改变请求归因 Header

`x-zcode-session-type` 是 Coding Plan 服务端消费的模型请求来源归因 Header。所有正式模型请求继续发送，并按来源
使用 `main`、`subagent` 或 `other`；Provider 连接测试属于无主 Agent/Subagent 的辅助调用，继续发送 `other`。
该 Header 不属于 Provider Config，也不在本 Todo 增加 Provider 特判。

## 3. 实施顺序

1. 先补失败测试，证明连接测试会 flush 尚未进入 Service 队列的 Provider debounce，并等待保存完成后才测试；
2. 让 idle、blur 与连接测试复用一个可等待的 Provider Draft Commit；
3. 删除连接测试中的 Model Config 保存/删除分支；
4. 从 UI、Services、Facade、Runtime 与 Config Service 公共面彻底删除旧 Model Config 写接口；
5. 简化 `ModelConnectivityResult`，删除 Services 重复错误分类；
6. 删除 UI Summary 和多 Endpoint 残余，直接渲染正式结果；
7. 清理过期注释、重复 input 类型、mock、测试 fixture 与无引用 export；
8. 更新 Provider Settings Design 与 Feature Graph，记录唯一保存/测试链路。

## 4. 测试

- UI 单测：idle 未触发时点击测试、blur 与测试并发、重复点击、保存失败、测试失败；
- Services 单测：Provider operation 串行、真实错误消息透传、不再分类；
- Provider 单测：所有模型编辑只经过 revision-guarded `savePersonalModelDraft`，旧接口机械归零；
- Bootstrap/Core 定向测试：Worker 刷新后精确创建正式 Model，最低 reasoning 继续取 `values[0]`；
- Desktop E2E：输入 Provider 字段后不失焦立即测试，确认请求使用最新配置且只产生一次有效草稿提交；
- `rg`/`dep:refs` 证明旧接口、Summary 和 `noEndpointResult` 零残留；
- `pnpm typecheck`、`pnpm lint`、相关格式检查与 `git diff --check`。

## 5. 完成标准

- 测试前保存与普通 Provider 自动保存共享一个提交原语；
- 连接测试不会用 Renderer 模型快照写入 Personal Model Rule；
- `savePersonalModelConfig`、`deletePersonalModelConfig`、`ModelConnectivitySummary`、
  `noEndpointResult` 与重复错误分类从生产代码及公共类型中消失；
- 正式 Registry/Model、Account 动态凭据、`x-zcode-session-type` 与最低 reasoning 行为保持不变；
- 交互、单测、类型检查和 lint 均通过后提交 Conventional Commit。

## 6. 实施结果与验证

- Provider idle、blur、切换 cleanup 与连接测试已经共用 `commitPendingDraft`；测试会先等待同一份 Provider
  草稿提交完成，再调用正式 `providerId/modelId` Model 测试入口。
- 连接测试不再接收 Renderer Model Config，也不再保存或删除 Personal Model Rule；
  `savePersonalModelConfig` / `deletePersonalModelConfig` 公共入口已从 UI、Facade、Runtime 和协议转发中删除。
- 结果契约已缩成成功或真实错误消息；`ModelConnectivitySummary`、`noEndpointResult` 和设置页字符串错误分类已删除。
- `x-zcode-session-type` 未进入 Provider Config；正式请求继续由统一执行链按 `main`、`subagent`、`other`
  写入，连接测试使用 `other`。
- UI、Services、Provider、CLI Adapter/Bootstrap/Core 定向单测通过；Desktop E2E 类型检查通过。桌面 case
  `coding-plan-team-usage` 已完成构建，但当前 Linux 环境缺少 `xvfb-run`，Chrome 无显示会话启动失败，因此运行态
  E2E 保持为环境阻塞，不记作业务断言失败。
