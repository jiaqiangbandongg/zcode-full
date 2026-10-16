# Todo 45：Models API 发布者证据工具

> 状态：待执行；真实目录校正受访问凭据阻塞
>
> 日期：2026-08-28
>
> 来源：Todo 41/43 完成后的 Built-in 模型事实复核

## 0. 任务定位

为 Built-in Provider Config 的维护者提供一个发布前证据工具。工具按正式 Provider 配置中的
`Endpoint + API Schema`，结合执行时提供的访问材料调用厂商 Models API，生成当前访问材料可见模型与
`builtinModelIds` 的差异报告。

```text
ZCode Built-in Provider Config
        |
        | Endpoint + API Schema + builtinModelIds
        v
Publisher Models API Inspector <--- 执行期访问材料
        |
        v
实时模型目录 / 已录制 Fixture
        |
        v
结构化差异报告
        |
        v
发布者人工复核并修改 Built-in Config
```

它是发布者维护工具，不是客户端 Runtime、Registry、Config Source 或第四层 Config Overlay。工具默认只报告，
不得自动改写 `zcode-builtin.json`。

## 1. 放置与边界

可复用实现放在：

```text
packages/provider-node/src/publisher/model-discovery/
```

这里可以复用正式 Built-in Release Parser、Provider Schema 和 Node 网络能力，但不得从
`@zcode/provider-node` 公共根入口导出，避免应用运行时依赖发布工具。

薄命令入口放在：

```text
scripts/provider/inspect-builtin-models.mjs
```

命令入口只负责参数、访问材料输入和报告输出；协议请求、响应解析与差异计算必须是可测试实现。推荐命令名表达
“采集和检查证据”，不使用会暗示完整业务校验的泛化 `validate`：

```bash
pnpm provider:inspect-models --provider minimax
```

## 2. 证据模式

工具应支持三种明确模式：

1. `live`：使用真实访问材料调用 Models API，形成带时间、Endpoint、Schema 和 Provider 身份的实时证据；
2. `fixture`：读取已脱敏、已审阅的响应 Fixture，验证协议解析和差异算法；
3. `static`：只通过正式 Parser 检查 Built-in 成员、Rule 解析等静态事实，不访问网络。

不同模式的报告必须显式标注证据等级。文档示例、Fixture 和实时响应不能混写为同一种“已验证”。

## 3. 凭据与安全边界

大多数厂商 Models API 需要 API Key、OAuth Token 或账号访问材料。没有访问材料时通常只能得到
`401/403`，不能证明该 Endpoint 当前真实可见的模型集合。

访问材料只在执行期注入：

- 优先从环境变量或标准输入读取；
- 禁止写入 Built-in Config、Fixture、差异报告或 Git；
- 禁止通过普通命令行参数传递明文，避免进入 shell history 和进程列表；
- 报告只记录凭据类型和不可逆标识，不记录原值；
- 同一厂商的 OpenAI-compatible 与 Anthropic-compatible Endpoint 分别请求和记录，不从其中一条外推另一条；
- Start/Individual/Team 等账号特定成员继续以 Account 产品接口和 Account Overlay 为准，通用 Models API
  不取代账号权益接口。

厂商没有 Models API、当前 Endpoint 不支持目录查询或当前访问材料无权限时，报告必须返回明确的
`unsupported`、`unauthorized` 或 `unavailable`，不得猜测目录。

## 4. 当前阻塞原因

当前阻塞的是“用实时接口全面校正 Built-in Config”，不是离线工具代码本身：

1. 当前工作环境没有各 Built-in 厂商对应的可用访问材料；
2. Models API 返回的是“当前访问材料可见目录”，不同账号、区域和套餐可能不同，匿名请求不能替代；
3. 各厂商的 Models 路径、认证方式与响应能力字段并不统一，必须逐个协议适配并用真实响应确认；
4. OpenAI-compatible 响应通常只证明模型身份，不能据此校正上下文、输出上限和多模态等未返回能力；
5. 在取得实时证据和人工审阅前，不能让工具自动修改发布配置。

因此当前 Built-in revision 仍属于“官网和产品事实校正版”，不能宣称已经过所有厂商 Models API 实时校正。
解除实时校正阻塞需要维护者为目标厂商提供可用的测试访问材料，或提供由可信环境采集并脱敏的真实响应。

## 5. 实施范围

- 定义统一的 discovery 结果、证据元数据和错误分类；
- 实现 OpenAI-compatible 与 Anthropic-compatible Models API 适配器；
- 从正式 Built-in Release 读取 Provider、Endpoint、Schema 和 `builtinModelIds`；
- 生成新增、缺失、共同成员、大小写差异和重复成员报告；
- 支持 JSON 与 Markdown 输出；
- Fixture 必须脱敏并带来源 Endpoint、Schema、采集时间和证据状态；
- 单个 Provider 失败不吞掉其他 Provider 的报告，但进程最终以非零状态表达未完成；
- 不直接进入应用启动、Registry 刷新、模型选择或普通模型请求链路；
- 不自动写 Config，不把接口返回的未知 capability 猜测映射进 Model Rules。

## 6. 测试与完成标准

- 用 Fixture 覆盖 OpenAI-compatible、Anthropic-compatible、未授权、不支持、畸形响应和分页；
- 使用真实 Domain Parser 读取 Built-in Release，不复制 Provider/Model Schema；
- 证明报告不会包含输入的秘密值；
- 证明模型目录差异只按 Provider 身份、Endpoint 和 Schema 比较，不跨 Provider 合并；
- 至少取得一个 OpenAI-compatible 和一个 Anthropic-compatible Endpoint 的真实脱敏证据；
- 为所有具备 Models API 且已提供访问材料的 Built-in Provider 生成并人工审阅报告；
- 无访问材料或无 Models API 的 Provider 明确保留证据缺口，不伪装为通过；
- 通过相关单测、`pnpm typecheck`、`pnpm lint`，并以 Conventional Commit 提交。

## 7. 与历史发布门禁讨论的关系

本 Todo 只解决“实时模型目录证据采集与差异报告”。已废弃的 Todo 19 曾讨论更大的 Built-in Release 业务完整性
发布门禁，包括发布责任、静态完整性、误发布/回滚、CI 准入和客户端最小防线。

如果未来重新建立发布门禁，Todo 45 的报告可以作为证据输入，但 Todo 45 本身不会升级为强制发布门禁。
