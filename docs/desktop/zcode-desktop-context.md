# ZCode Desktop Context

## 状态

- 本文是 ZCode Desktop 输出呈现约束进入 Agent system prompt 的当前功能规范。
- Desktop context 继续负责要求 Agent 输出 `::code-comment{...}`；Renderer 的解析、卡片和 Review 跳转由
  [Assistant Code Comment Cards](../ui/assistant-code-comment-cards.md) 独立规范，并受默认关闭的灰度能力控制。
- Identity 中关于 terminal 展示的既有文案本阶段保持不变。

## 功能摘要

| 字段     | 结论                                                                                    |
| -------- | --------------------------------------------------------------------------------------- |
| 改动层级 | presentation、runtime config                                                            |
| 用户入口 | ZCode Desktop 本地 workspace、Desktop-attached SSH/WSL/Docker workspace                 |
| 评估入口 | `zcode --surface desktop --prompt <text>`                                               |
| 权威状态 | Services 根据可信宿主事实推导、并在 Agent 启动时冻结的 `presentationSurface`            |
| 默认值   | `terminal`                                                                              |
| 不涉及   | UI directive 解析、协议 schema、telemetry、provider `sourceTitle`、V4 delivery/recovery |

## Context Section 契约

Desktop surface 使用独立的 `buildDesktopContextSection()`，并遵守以下元数据：

```text
name: ZCode Desktop Context
source: desktop_context
injectionTarget: system
cacheHint: stable
```

正文固定为：

```text
# ZCode Desktop Context

### Files & URLs
- Return local web URLs as Markdown links (e.g., [label](http://127.0.0.1:8080)).
- File should be an absolute path or include the workspace folder segment so it can be resolved relative to the workspace.
- Unless otherwise specified, return local file references as Markdown links (e.g., [name.md](/absolute/path/to/name.md)).

### Inline Code Comments
- Use the ::code-comment{...} directive when you need to attach feedback directly to specific code lines.
- Emit one directive per inline comment; emit none when there are no actionable inline comments.
- Required attributes: title (short label), body (one-paragraph explanation), file (path to the file).
- Optional attributes: start, end (1-based line numbers), priority (0-3).
- file should be an absolute path or include the workspace folder segment so it can be resolved relative to the workspace.
- Keep line ranges tight; end defaults to start.
- Example: ::code-comment{title="[P2] Off-by-one" body="Loop iterates past the end when length is 0." file="/path/to/foo.ts" start=10 end=11 priority=2}
```

默认 system section 顺序为：

```text
CLI Prefix
Agent Identity
ZCode Desktop Context       <- stable，仅 zcode_desktop
Dynamic Behavior            <- dynamic
Session Guidance
Environment
...
```

`ZCode Desktop Context` 与 Identity 进入同一个稳定 system message，不新增 system message 数量。
`customSystemPrompt` 会替换默认 system prompt 体系，因此不注入 Desktop context。Subagent 使用独立
context builder，也不注入 Desktop context。

## Surface 与启动链路

内部类型：

```ts
type PresentationSurface = "terminal" | "zcode_desktop";
```

真实 Desktop 不要求调用方显式拼接 CLI 参数。Services 使用已有宿主事实推导呈现面，再由
`ZCodeAgentProcessManager` 统一追加 CLI 参数；CLI 评估仍使用公开参数入口：

```text
Desktop Local Host
  └─ agentTelemetry.runtimeSurface=desktop_local_host ─────┐
                                                           ├─> Services 内部推导 desktop
Desktop-attached Remote Host                               │            |
  └─ serviceAuthorityMode=desktop-attached-remote ─────────┘            v
                                                    app-server --stdio --surface desktop
                                                                       |
zcode --surface desktop --prompt ... -> CLI 参数解析 ──────────────────+
                                                                       |
                                                                       v
                                                    presentationSurface=zcode_desktop
                                                                       |
                                                                       v
                                              AgentRuntimeConfig -> ContextBuilderConfig
```

远程 Desktop Host 的集成证据必须贯穿以下装配链，不能只分别断言 authority parser 或 surface helper：

```text
remote connect command
  -> ZCODE_SERVICE_AUTHORITY_MODE=desktop-attached-remote
  -> entry-stdio bootstrap
  -> createLocalServices(serviceAuthorityMode)
  -> ZCodeAgentProcessManager command resolver context
  -> app-server --stdio --surface desktop
  -> protocol runtime presentationSurface=zcode_desktop
```

普通 `zcode --prompt`、TUI、HTTP server 或人工执行 `zcode app-server --stdio` 默认保持 `terminal`。
`--surface` 只允许用于 `--prompt`、`--target`、`app-server` 和 `agent-server`；支持值为
`terminal`、`desktop`。

`--surface desktop` 只模拟输出呈现能力，不修改：

- provider `sourceTitle`；headless CLI 仍是 `cli`，Protocol/Desktop 仍是 `electron`。
- telemetry `runtimeSurface`。
- Desktop `desktop-continuous` 与手机 `web-remote-replayable` 的 delivery/recovery 语义。

## 多端与远程边界

Desktop 本地 workspace 通过既有 `agentTelemetry.runtimeSurface=desktop_local_host` 识别，
Desktop-attached SSH/WSL/Docker workspace 通过既有
`serviceAuthorityMode=desktop-attached-remote` 识别；两者都使用 `zcode_desktop`。调用方不再传递独立的
surface 配置，避免展示策略扩散到 Desktop Host 和 remote server 装配层。

手机 `/remote` 不会另起 Agent，而是 attach 到桌面窗口已有的 Host/CLI；它会看到同一 Agent 生成的文本，
但仍使用 `web-remote-replayable`。Desktop Root 与手机 external relay、token/WebSocket 两条 workspace
bridge Root 都显式开启灰度能力，Renderer 从同一原始 row text 确定性投影正文和 code-comment 卡片；
普通 Web Server 入口保持默认关闭并继续显示原始 directive。该 UI 投影不改变 continuous/replayable
交付边界，也不向 session snapshot 增加字段。

该配置不进入 ZCode Protocol request，也不参与 workspace identity。远程 workspace 仍使用
`workspaceIdentity?.trim() || workspacePath` 做隔离，`workspacePath` 只用于 Agent cwd。

## Desktop SP 服务端灰度

Desktop Main 在启动时旁路请求 `/api/v1/client/configs`，后续 Host 创建时按 1 小时 TTL 触发过期刷新，
读取以下配置：

```json
{
  "data": {
    "configs": {
      "desktopContextPrompt": {
        "enabled": true,
        "config_version": "desktop-sp-v1"
      }
    }
  }
}
```

只有 `code` 缺省或为 `0` 的成功响应才进入配置裁决：下发配置时要求 `enabled` 为 boolean；未下发
`desktopContextPrompt` 时按 `{enabled:false}` 处理并覆盖旧的开启快照。Main 将本次裁决快照通过
`ZCODE_DESKTOP_CONTEXT_PROMPT_ENABLED=1|0` 传给 Local Host，并沿现有 Remote runtime env 白名单
传给 Desktop-attached 的远端 Host；Host 不请求服务端、不重新分桶。未提供该环境变量时，保留历史
Host 装配语义，便于 CLI、普通 HTTP server 和已有测试继续运行。

成功结果在 Desktop Main 进程内缓存 1 小时，并合并同一时刻的 in-flight 请求。单次请求最多等待 3 秒：

```text
Main ready
   |
   +-- request config (旁路，不阻塞首个 Host)
   |       |
   |       +-- success + valid --> cache {enabled, config_version}
   |       |
   |       +-- error/invalid/timeout (>3s)
   |                    |
   |                    +-- 有历史成功 --> 复用上一份快照
   |                    +-- 无历史成功 --> {enabled:false}
   |
   +-- Host spawn --> 读取当时快照 --> 注入/不注入 Desktop Context
```

网络失败、响应异常或超时都不会阻塞客户端启动。成功快照仅在当前 Desktop Main 生命周期内复用；
新启动的 Host 读取最新快照，已经启动的 Agent 不在运行中动态切换呈现面。

## 验收用例

| Case    | Setup                                                  | Action                             | Assertions                                               |
| ------- | ------------------------------------------------------ | ---------------------------------- | -------------------------------------------------------- |
| DCTX-01 | 默认/terminal ContextBuilder                           | 构建 context                       | 不包含 `desktop_context`                                 |
| DCTX-02 | `zcode_desktop` ContextBuilder                         | 构建 context                       | section 恰好一次，元数据准确，位于 `dynamic_behavior` 前 |
| DCTX-03 | `zcode_desktop` + custom system prompt                 | 构建 context                       | 不包含 `desktop_context`                                 |
| DCTX-04 | subagent runtime                                       | 构建 context                       | 不包含 `desktop_context`                                 |
| DCTX-05 | `--surface desktop --prompt`                           | 创建 App                           | runtime config 为 `zcode_desktop`，`sourceTitle` 不变    |
| DCTX-06 | `app-server --stdio --surface desktop`                 | 启动 protocol runner               | 每个 session App 注入 `zcode_desktop`                    |
| DCTX-07 | local Desktop runtime fact / attached remote authority | 创建 Services 并解析 Agent command | 参数包含 `--surface desktop`                             |
| DCTX-08 | 普通 HTTP server/manual stdio，无 Desktop 宿主事实     | 创建 Services 并解析 Agent command | 不自动添加 Desktop surface                               |
| DCTX-09 | 非法值/不支持命令                                      | CLI 参数校验                       | 返回清晰错误，不启动 App                                 |
| DCTX-10 | `entry-stdio` 收到 `desktop-attached-remote`           | 经真实 Services 装配解析 Agent 命令 | authority、resolver surface、命令参数均保持 Desktop      |

## 影响简报

| Rank           | 关系                                           | 结论                                      |
| -------------- | ---------------------------------------------- | ----------------------------------------- |
| must-inspect   | CLI parser -> Runtime config -> ContextBuilder | Desktop section 的唯一注入主链            |
| must-inspect   | Host facts -> Services -> Agent process args   | 复用可信宿主事实推导 Desktop surface      |
| conditional    | 手机 remote -> shared Host/CLI                 | 继承同一 prompt，但不改变 replayable 交付 |
| invariant-only | `sourceTitle` / telemetry                      | 不随 CLI 评估参数改变                     |
| invariant-only | custom prompt / subagent                       | 不注入 Desktop 默认 section               |
| evidence-only  | Core/CLI/Bootstrap/Services/Server 集成测试    | 覆盖本地与远程宿主装配，不增加 UI E2E     |

当前 codegraph 工具在环境中不可用，影响范围依据功能图、当前事实文档、源码直接调用方和既有测试核对。
