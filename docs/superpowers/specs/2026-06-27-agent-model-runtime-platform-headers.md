# Agent Model Runtime Platform Headers

## 背景

Agent 模型请求已经携带 `User-Agent`、`X-ZCode-App-Version`、`X-Title`、`x-request-id`
和 `x-session-id` 等来源与请求归因 header。后端排查模型请求时，还需要知道发起请求的
agent runtime 所在机器的操作系统、CPU 架构和系统版本，用来区分 macOS、Windows、Linux
以及远程 workspace 上的运行环境。

## 目标

- 所有 zcode-cli agent 模型请求默认携带运行环境 header：
  - `X-Platform`: `${process.platform}-${arch()}`
  - `X-Os-Category`: `macos` / `windows` / `linux`
  - `X-Os-Version`: `release()`
- header 语义表示真正发起模型请求的 agent runtime 机器。远程 SSH / WSL / Docker workspace
  由远端 zcode-cli runtime 生成 header，因此记录远端环境，不记录本机桌面或手机 `/remote`
  客户端环境。
- 复用 app 侧已有的 header 名称，不新增 `X-ZCode-OS` / `X-ZCode-Arch` / `X-ZCode-OS-Version`。
- header 值只允许可打印 ASCII；无法生成安全值时省略对应可选 header，避免 HTTP fetch
  在发送前因非法 header value 失败。
- 用户在 provider config 中显式配置同名 header 时继续覆盖默认环境 header。

## 非目标

- 不修改 `@zcode/protocol`，这些环境信息不需要从 app 传给 agent。
- 不改变 `x-request-id`、`x-zcode-trace-id`、`x-session-id`、`x-query-id` 的请求级归因语义。
- 不把手机 `/remote` 的设备信息写入 agent 模型请求 header。
- 不新增环境变量或用户可见设置。

## 设计

运行环境 header 在 `apps/zcode-cli/packages/bootstrap/src/model-config.ts` 的 provider 默认
header 生成阶段构造，和 `User-Agent`、`X-ZCode-App-Version`、`X-Title`、`X-ZCode-Agent`
保持同一层级。

合并顺序保持现状：

1. bootstrap 生成 provider 默认 header。
2. provider config 中的 `target.headers` 覆盖默认 header。
3. adapter 在单次 `generateText` / `streamText` 请求发送前合入请求级归因 header。

这样平台 header 不会污染 session/request 动态归因，也不会绕过用户显式 provider header
配置。

## 覆盖矩阵

| Case ID | Setup | Action | Assertions | Evidence |
| --- | --- | --- | --- | --- |
| AMRPH-001 | 默认 provider config 无自定义 header | 创建 AI SDK provider registry config | provider headers 包含 `X-Platform`、`X-Os-Category`、`X-Os-Version` | bootstrap 单测 |
| AMRPH-002 | provider config 显式设置同名 header | 创建 AI SDK provider registry config | 用户配置覆盖默认平台 header | bootstrap 单测 |
| AMRPH-003 | provider headers 已含平台 header | 创建 `generateText` 请求 options | 平台 header 与 `x-request-id`、`x-session-id` 等请求级归因 header 共存 | adapter options 单测 |

## 验证

- 执行 `pnpm --dir apps/zcode-cli --filter @zcode/bootstrap test -- model-config`。
- 执行 `pnpm --dir apps/zcode-cli --filter @zcode/adapters test -- runner-options`。
- 按仓库要求执行 `pnpm typecheck` 和 `pnpm lint`。
