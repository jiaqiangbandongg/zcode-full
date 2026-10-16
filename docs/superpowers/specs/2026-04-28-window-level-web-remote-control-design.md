# 窗口级 Web 远程控制设计

> **已废弃：** 本设计描述的是已移除的仓库内 relay / `remoteControlToken` / `bridgeToken` 方案。当前实现使用外部 relay `wss://zcode.z.ai/ws` 与 `/remote` QR 参数，业务消息统一封装在 `data.payload`。

## 背景

当前 Web 远程控制的 `token/sessionId` 绑定到某个 workspace 的一次访问。手机扫码后进入的是当前 workspace 的旁路访问；跨 workspace 打开 task 时，会在同一条 relay control tunnel 下创建新的 relay session，并跳转到新的 `connectUrl` 重新 bootstrap。

这个模型适合“分享当前 workspace”，但不适合“手机端在一个有效期内控制整个 desktop 窗口”。目标模型应把“手机对窗口的短期 pairing 授权”和“当前 workspace 的数据桥”拆开。

## 目标

第一版改造目标：

1. 手机端在 `deviceToken` 有效期内控制一个 desktop 窗口，而不是某个 workspace。
2. 同一个 desktop 窗口同一时间只允许一个手机页面连接。
3. 手机端和桌面端拥有独立的选中状态，手机切 workspace/task 不反向切桌面端当前 tab/task。
4. 手机端和桌面端共享底层 workspace/task 数据。手机操作 `task-b` 后，桌面端仍可留在 `task-a`；桌面端之后手动切到 `task-b` 时能看到手机端产生的结果。
5. 桌面端 main 进程可以查询手机当前查看的 workspace/task。
6. 第一版仍只支持访问 desktop 当前窗口内已经打开的 workspace，不支持手机端新建窗口外 workspace。

## 非目标

第一版不做：

1. 多手机同时控制同一个 desktop 窗口。
2. 手机操作反向同步桌面端当前选中 tab/task。
3. 手机端直接新建 local workspace。
4. 手机端直接新建 SSH / WSL / Docker remote workspace session。
5. 多 workspace bridge 同时保活。
6. 完整权限系统、只读模式、设备列表和长期设备管理。

## 核心模型

新模型拆成窗口级控制会话和 workspace 数据桥。

```text
Desktop Window
  └── WindowControlSession
        ├── windowControlSessionId
        ├── deviceToken
        ├── tunnelId
        ├── mobileConnected
        ├── mobileViewState
        │     ├── activeWorkspaceKey
        │     ├── activeTaskId
        │     └── updatedAt
        └── currentWorkspaceBridge
              ├── bridgeSessionId
              ├── workspaceKey
              ├── workspacePath
              ├── kind: local | remote
              ├── remote.workspaceIdentity
              ├── remote.remoteSessionId
              └── initialTaskId?
```

语义变化：

```text
旧模型:
  token/sessionId = 某个 workspace 的一次访问

新模型:
  deviceToken/windowControlSessionId = 控制整个 desktop 窗口
  bridgeSessionId = 手机当前打开的 workspace 数据桥
```

视图状态和业务状态分离：

```text
desktop activeTaskId = 桌面端当前选择
mobile activeTaskId  = 手机端当前选择
task data/runtime    = 双端共享
```

## 共享类型

`packages/shared/src/web-remote-control.ts` 增加窗口级类型。

```ts
export type WebRemoteControlTokenKind = "window-pairing";

export type WebRemoteControlWindowFailureReason =
  | WebRemoteControlFailureReason
  | "invalid-mobile-connection"
  | "desktop-bootstrap-timeout";

export interface WebRemoteControlWindowSession {
  windowControlSessionId: string;
  deviceToken: string;
  tokenKind: WebRemoteControlTokenKind;
  connectUrl: string;
  qrUrl: string;
  expiresAt: number;
  status: "idle" | "starting" | "running" | "active" | "error";
}

export interface WebRemoteControlMobileViewState {
  activeWorkspaceKey?: string;
  activeTaskId?: string;
  updatedAt: number;
}

export interface WebRemoteControlLocalWorkspaceBridge {
  bridgeSessionId: string;
  bridgeToken: string;
  kind: "local";
  workspaceKey: string;
  workspacePath: string;
  initialTaskId?: string;
  wsUrl: string;
}

export interface WebRemoteControlRemoteWorkspaceBridge {
  bridgeSessionId: string;
  bridgeToken: string;
  kind: "remote";
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity: string;
  remoteSessionId: string;
  initialTaskId?: string;
  wsUrl: string;
}

export type WebRemoteControlWorkspaceBridge =
  | WebRemoteControlLocalWorkspaceBridge
  | WebRemoteControlRemoteWorkspaceBridge;

export interface WebRemoteControlWindowBootstrapResult {
  windowControlSessionId: string;
  workspaces: WebRemoteControlWorkspaceTarget[];
  tasks: WebRemoteControlTaskTarget[];
  mobileViewState?: WebRemoteControlMobileViewState;
}

export interface WebRemoteControlWindowControlReadyEvent {
  type: "window-control-ready";
  windowControlSessionId: string;
  mobileConnectionId: string;
  expiresAt: number;
}
```

`resolveWebRemoteControlWorkspaceKey()` 继续使用现有规则：

```ts
workspaceKey = workspaceIdentity?.trim() || workspacePath;
```

约束：

1. `deviceToken` 是短期窗口 pairing token，不是永久设备凭据。
2. `deviceToken` 默认 8 小时过期；手机端有有效操作时滑动刷新 `expiresAt`。
3. 过期刷新只允许发生在当前 active mobile connection 上，不能靠裸 `deviceToken` 刷新。
4. remote workspace 的 bridge / target / task 必须带 `workspaceIdentity`，并且 `workspaceKey` 必须按 `workspaceIdentity?.trim() || workspacePath` 计算。
5. remote identity 的构造复用统一工具，例如 `buildRemoteWorkspaceIdentity`；禁止在 relay、desktop main 或 web 里手写拼接规则。
6. 桌面端二维码里的 `deviceToken` 本身就是本次远控的一次性授权，mobile web 携带 `remoteControlToken` 访问时不要求先登录。
7. `invalid-mobile-connection` 和 `desktop-bootstrap-timeout` 要进入共享错误类型，避免 relay/web/测试使用裸字符串。

## Relay 协议

Relay 需要拆分两类 session manager。

```text
WindowControlSessionManager
  deviceToken -> window control session

WorkspaceBridgeSessionManager
  bridgeToken / bridgeSessionId -> workspace bridge session
```

窗口级 session 只保存授权、连接和当前 mobile lease；workspace/task 快照不缓存在 relay。

```text
deviceToken
  ├── expiresAt
  ├── activeMobileConnectionId?
  └── activeWindowControlSocket?
```

窗口级 API：

```text
POST /api/remote-control/windows
  Desktop main 创建窗口级远控 session，返回 8 小时滑动过期的 deviceToken。

GET /api/remote-control/windows/bootstrap/:deviceToken
  Mobile web bootstrap。Relay 校验 deviceToken 未过期后，通过 desktop control socket 实时请求窗口内 workspace/task 快照和 mobileViewState。

WS /ws/remote-control/window/:deviceToken
  Mobile window control socket。第一版只允许一个 mobile socket。连接成功后 relay 下发 mobileConnectionId。

POST /api/remote-control/windows/:deviceToken/workspace-bridge
  Mobile 请求打开或切换 workspace bridge。必须携带当前 active mobileConnectionId。

POST /api/remote-control/windows/:deviceToken/mobile-view-state
  Mobile 上报当前 activeWorkspaceKey / activeTaskId。必须携带当前 active mobileConnectionId。
```

变更类 HTTP API 的连接校验：

```text
X-ZCode-Mobile-Connection-Id: <mobileConnectionId>
```

Relay 只接受 `activeMobileConnectionId` 匹配且对应 window control socket 仍打开的请求；否则返回 `401 invalid-mobile-connection` 或 `409 session-conflict`。这样第二个浏览器标签页即使知道 `deviceToken`，在 window control socket 被拒后也不能切 bridge 或覆盖 `mobileViewState`。

window control socket 连接成功后，relay 向 mobile 发送：

```json
{
  "type": "window-control-ready",
  "windowControlSessionId": "<windowControlSessionId>",
  "mobileConnectionId": "<mobileConnectionId>",
  "expiresAt": 0
}
```

Mobile 只有收到该事件后，才允许请求 `workspace-bridge` 或 `mobile-view-state`。

`deviceToken` 滑动刷新规则：

1. bootstrap 只校验过期，不刷新过期时间。
2. window control socket 连接成功后刷新一次。
3. `workspace-bridge` / `mobile-view-state` 校验 active connection 成功后刷新一次。
4. 连接断开后清空 `activeMobileConnectionId`，后续裸 token 请求不能刷新过期时间。

数据桥 API：

```text
WS /ws/remote-control/bridge/:bridgeToken
  Mobile 当前 workspace 的 RPC 数据 socket。

WS /ws/desktop/bridge/:bridgeSessionId
  Desktop main 专用 host bridge 的数据 socket。
```

`/r/:deviceToken` 可以继续保留，但语义改成窗口入口。Relay 重定向到 web 时仍可使用：

```text
?remoteControlToken=<deviceToken>&relayOrigin=<relay-origin>
```

这样前端 URL 参数名字可以暂时不变，减少入口改动。

## 访问与登录策略

第一版把桌面端二维码视为一次性短期授权入口，不把 Web 登录作为远控使用前置条件。

访问规则：

1. URL 带 `remoteControlToken` 时，mobile web 跳过当前 Web OAuth 登录门禁，直接进入 relay bootstrap。
2. `remoteControlToken` 的安全边界由 8 小时滑动过期、active `mobileConnectionId` 和单手机连接策略承担。
3. URL 不带 `remoteControlToken`、直接访问 `/web-remote` 时，继续走现有登录页 / 登录后 waiting page，用于后续设备列表和长期设备管理。
4. 如果浏览器已经登录，第一版不额外做 token owner / device grant 校验，仍按一次性 token 流程使用。
5. 登录态增强鉴权是后续能力：可以在 bootstrap 前增加“登录用户 + device grant + window session”校验，但不能阻塞当前二维码免登录流程。
6. 后续加入登录态增强鉴权、device grant 或 feature flag 时，必须通过 Providers 注入横切能力，禁止 web / relay / desktop main 直接引用具体鉴权或开关实现。

`packages/web/src/main.tsx` 的入口判断需要拆分：

```ts
hasRemoteControlToken = params.has("remoteControlToken");

if (hasRemoteControlToken) {
  // 二维码一次性 token 模式：不要求 Web OAuth 登录。
  return bootstrapWebRemoteControlByToken();
}

if (isWebRemoteRoute()) {
  // 登录后的设备列表 / waiting page 模式。
  return bootstrapWebRemoteAuthShell();
}
```

## Desktop Control 消息

Desktop main 与 relay 的 control socket 继续承担控制面，不承载 RPC 二进制帧。

新增消息：

```ts
type RelayDesktopControlEvent =
  | { type: "window-control-registered"; tunnelId: string }
  | {
      type: "window-bootstrap-request";
      requestId: string;
      windowControlSessionId: string;
    }
  | {
      type: "window-bootstrap-response";
      requestId: string;
      windowControlSessionId: string;
      success: true;
      result: WebRemoteControlWindowBootstrapResult;
    }
  | {
      type: "window-bootstrap-response";
      requestId: string;
      windowControlSessionId: string;
      success: false;
      error: string;
    }
  | { type: "mobile-connected"; windowControlSessionId: string }
  | { type: "mobile-disconnected"; windowControlSessionId: string }
  | {
      type: "workspace-bridge-request";
      requestId: string;
      windowControlSessionId: string;
      workspaceKey: string;
      taskId?: string;
    }
  | {
      type: "workspace-bridge-response";
      requestId: string;
      windowControlSessionId: string;
      success: true;
      bridge: WebRemoteControlWorkspaceBridge;
    }
  | {
      type: "workspace-bridge-response";
      requestId: string;
      windowControlSessionId: string;
      success: false;
      error: string;
    }
  | {
      type: "mobile-view-state-update";
      windowControlSessionId: string;
      viewState: WebRemoteControlMobileViewState;
    };
```

现有 workspace list、platform request 仍走 control socket。第一版可以保留现有 request/response 形态，但参数语义要从 workspace session token 改成 window control session。

## Window Bootstrap 快照来源

`GET /api/remote-control/windows/bootstrap/:deviceToken` 的返回值以 desktop main 为准，relay 不保存 workspace/task 快照。

Bootstrap 时序：

1. Mobile 请求 bootstrap。
2. Relay 校验 `deviceToken` 存在且 `expiresAt > Date.now()`。
3. Relay 找到对应 desktop control tunnel。
4. Relay 发送 `window-bootstrap-request { requestId, windowControlSessionId }`。
5. Desktop main 从当前 window runtime 读取：
   - renderer 已同步的 `WebRemoteControlWorkspaceTarget[]`
   - renderer 已同步的 `WebRemoteControlTaskTarget[]`
   - main 内存里的 `mobileViewState`
6. Desktop main 返回 `window-bootstrap-response`。
7. Relay 原样返回给 mobile。

错误语义：

1. token 不存在或已过期：`404/410 session-not-found | session-expired`。
2. desktop control tunnel 不存在或已断开：`410 desktop-disconnected`。
3. desktop main 10 秒内未响应：`504 desktop-bootstrap-timeout`。
4. renderer 尚未同步 workspace/task：允许返回空数组，但必须带 `windowControlSessionId`；mobile 进入空态并提供刷新。
5. 某个 remote workspace 缺少 `workspaceIdentity` 或 `remoteSessionId`：desktop main 在快照中过滤该 workspace，避免 mobile 进入不可桥接状态。

## Desktop Main 改造

`WebRemoteControlManager` 从 workspace runtime 改为 window runtime。

```ts
interface WindowControlRuntime {
  windowId: number;
  windowControlSessionId: string;
  deviceToken: string;
  expiresAt: number;
  activeMobileConnectionId?: string;
  tunnelId: string;
  connectUrl: string;
  qrUrl: string;
  controlSocket: WebSocket;
  mobileConnected: boolean;
  mobileViewState?: WebRemoteControlMobileViewState;
  currentBridge?: WorkspaceBridgeRuntime;
  error?: string;
  failure?: WebRemoteControlFailure;
}

interface LocalWorkspaceBridgeRuntime {
  bridgeSessionId: string;
  bridgeToken: string;
  kind: "local";
  workspaceKey: string;
  workspacePath: string;
  initialTaskId?: string;
  host?: WebRemoteControlHostHandle;
  dataSocket?: WebSocket;
  disposeBridge?: () => void;
}

interface RemoteWorkspaceBridgeRuntime {
  bridgeSessionId: string;
  bridgeToken: string;
  kind: "remote";
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity: string;
  remoteSessionId: string;
  initialTaskId?: string;
  host?: WebRemoteControlHostHandle;
  dataSocket?: WebSocket;
  disposeBridge?: () => void;
}

type WorkspaceBridgeRuntime =
  | LocalWorkspaceBridgeRuntime
  | RemoteWorkspaceBridgeRuntime;
```

`start(windowId)` 行为：

1. 停掉当前窗口已有 window runtime。
2. 连接 relay `/ws/desktop/control`。
3. 获取 `tunnelId`。
4. POST `/api/remote-control/windows` 创建窗口级 session。
5. 保存 `WindowControlRuntime`。
6. 返回 `deviceToken / connectUrl / qrUrl / windowControlSessionId` 给桌面弹层。

`createWorkspaceBridge(windowId, workspaceKey, taskId?)` 行为：

1. 从当前窗口已同步的 workspace 列表里找目标 workspace。
2. 如果目标是 remote workspace，要求同时存在 `remoteSessionId` 和 `workspaceIdentity`。
3. 释放旧 `currentBridge` 的 host、data socket 和协议桥。
4. 请求 relay 创建 bridge session。
5. local workspace 通过 `InitLocal` 创建 dedicated host。
6. remote workspace 根据 `remoteSessionId` 找原 remote target，通过 `InitRemote` 创建 dedicated host。
7. 连接 `/ws/desktop/bridge/:bridgeSessionId`。
8. 桥接 relay data socket 与 host `MessagePort`。

`mobileViewState` 行为：

1. 收到 `mobile-view-state-update` 后只写入 window runtime。
2. 可选转发给 desktop renderer，用于展示“手机正在查看 task-b”。
3. 禁止写入桌面端 active tab/task 状态。

## Web 改造

`packages/web/src/main.tsx` 保持 `remoteControlToken` 参数名，但把它解释为 `deviceToken`。

Bootstrap 流程：

1. 如果 URL 带 `remoteControlToken`，跳过 Web OAuth 登录检查。
2. `GET /api/remote-control/windows/bootstrap/:deviceToken`。
3. 获取窗口内 workspace/task 列表和 `mobileViewState`。
4. 建立 `WS /ws/remote-control/window/:deviceToken`。
5. 收到 relay 下发的 `mobileConnectionId`。
6. 如果已有 `mobileViewState.activeWorkspaceKey`，优先打开该 workspace；否则打开第一个可用 workspace。
7. 携带 `X-ZCode-Mobile-Connection-Id` 请求 `workspace-bridge`，拿到 bridge `wsUrl`。
8. 用 bridge `wsUrl` 建立当前 workspace 的 service accessor。
9. 渲染 `Root`，传入 `initialWorkspaceAbsPath / initialWorkspaceIdentity / initialTaskId`。

普通 `/web-remote` 流程：

1. URL 不带 `remoteControlToken` 时继续走现有 Web OAuth 登录逻辑。
2. 未登录展示登录页。
3. 已登录展示 waiting page，等待后续设备列表能力。
4. 这条路径不影响二维码一次性 token 访问。

Task 点击行为：

1. 同 workspace task：
   - 调 UI 自己的 `onSelectTask()`。
   - 携带 `X-ZCode-Mobile-Connection-Id` POST `mobile-view-state`。
   - 不通知 desktop renderer 切换。
2. 跨 workspace task：
   - 携带 `X-ZCode-Mobile-Connection-Id` POST `workspace-bridge`。
   - 替换当前 bridge service accessor。
   - 更新 web 本地 `activeWorkspaceKey / activeTaskId`。
   - 携带 `X-ZCode-Mobile-Connection-Id` POST `mobile-view-state`。
   - 不换 `deviceToken`，不跳新的窗口级入口。

第一版可以通过重新挂载 `Root` 来替换 service accessor，避免在 UI 层引入复杂的多 accessor 热切换。重新挂载只发生在手机切 workspace 时，不影响桌面端。

## 桌面端可见手机状态

Desktop main 保存单份 `mobileViewState`：

```ts
type MobileViewState = {
  activeWorkspaceKey?: string;
  activeTaskId?: string;
  updatedAt: number;
};
```

桌面端如果需要展示，可以新增平台事件：

```text
PlatformChannels.WebRemoteControlMobileViewStateChanged
```

新增该事件时必须同时修改：

1. `packages/shared/src/channels.ts` 的 `PlatformChannels`。
2. `PlatformChannelMap` 的 request/response 类型。
3. `packages/shared/src/platform.ts` 的 `IPlatformService` 订阅接口。
4. desktop preload / renderer platform 实现。
5. web fallback no-op，实现 desktop / web 兼容。

renderer 订阅后只展示状态，不改变当前选中项。禁止在 renderer 里直接监听硬编码字符串频道。

## 数据共享与刷新

为了保证手机操作结果能被桌面端后续看到，采用低风险刷新策略。

1. 手机 bridge host 对 task 的写入仍落到同一套 workspace/task 持久化。
2. 桌面端手动切入某个 task 时，对该 task 强制 reload 消息和运行状态。
3. 第一版不依赖 mobile host 到 desktop renderer 的实时 invalidation，避免 main 解析 RPC 数据帧或维护第二套跨 host 事件总线。

如果后续要做实时 invalidation，必须先补正式平台频道和事件来源：

```text
PlatformChannels.WebRemoteControlTaskInvalidated
{ workspaceKey, taskId }
```

事件来源必须是 service/runtime 层显式发出的 task updated 领域事件，再由 desktop main 转发；禁止使用散落硬编码字符串，也禁止通过解析 RPC 二进制帧推断 task 更新。

renderer 收到后只标记缓存过期，不改变当前 active task。这样手机端持续操作不会打断桌面端，但桌面端进入该 task 时能看到最新结果。

第一版不做跨端 Zustand 强同步，也不把 mobile host 注册到 desktop `BroadcastHub`。

## 单手机连接策略

第一版同一 `deviceToken` 只允许一个 mobile window control socket。

如果第二个手机或第二个浏览器标签页连接：

1. Relay 返回或关闭为 `session-conflict`。
2. 不签发新的 `mobileConnectionId`。
3. 不自动踢掉旧手机。
4. 任何来自第二个页面的 `workspace-bridge` / `mobile-view-state` HTTP 请求都会因为缺少 active `mobileConnectionId` 被拒绝。
5. 桌面弹层状态显示冲突错误或保持已有 active 状态。

选择“不踢旧端”可以避免用户扫码误操作导致当前手机会话被中断。

## 迁移步骤

1. 共享协议层
   - 扩展 `packages/shared/src/web-remote-control.ts`。
   - 增加 window session、bridge session、mobile view state、mobile connection lease 类型。
   - remote workspace 类型必须强制携带 `workspaceIdentity` 和 `remoteSessionId`。
   - 保留旧类型一段时间，降低分步迁移风险。

2. Relay
   - 拆分 window session manager 和 bridge session manager。
   - 新增窗口级 bootstrap、workspace bridge、mobile view state API。
   - `deviceToken` 实现 8 小时过期和 active connection 滑动刷新。
   - `workspace-bridge` / `mobile-view-state` 校验 active `mobileConnectionId`。
   - bootstrap 通过 desktop control socket 实时拉取快照，不在 relay 缓存 workspace/task。
   - 保留 `/r/:token` 入口，改语义为 `deviceToken`。
   - 实现单手机连接冲突处理。

3. Desktop Main
   - 重构 `webRemoteControlManager` 状态模型。
   - `start()` 改为创建 window runtime。
   - 新增 `createWorkspaceBridge()`。
   - remote bridge 创建前强校验 `workspaceIdentity` 和 `remoteSessionId`。
   - 响应 `window-bootstrap-request`，返回当前窗口已同步的 workspace/task 快照。
   - 保存并暴露 `mobileViewState`。
   - remote workspace bridge 继续复用现有 `createWebRemoteControlHost()` 的 InitRemote 路径。

4. Web
   - bootstrap 改为窗口级。
   - `remoteControlToken` 模式绕过 Web OAuth 登录门禁，直接走一次性 token bootstrap。
   - 普通 `/web-remote` 无 token 模式保留登录 / waiting page。
   - 先建立 window control socket 并拿到 `mobileConnectionId`，再请求 bridge 或上报 view state。
   - task 点击改为更新 mobile view state 或切换 workspace bridge。
   - 跨 workspace 不再跳新的 `connectUrl`。
   - 仍禁用直接新建 remote workspace。

5. UI 与刷新
   - 桌面弹层展示窗口级远控状态。
   - 可选展示手机当前 workspace/task；若新增事件订阅，必须走 `PlatformChannels` + `IPlatformService`，禁止硬编码频道。
   - 桌面 task 切换时补强制 reload；实时 invalidation 留到正式平台频道和领域事件来源都补齐后再做。

6. 清理旧模型
   - 删除 workspace session token 绑定假设。
   - 更新 `docs/web-remote-control/web-remote-control-architecture.md`。
   - 更新相关测试命名和 fixture。

## 测试计划

Relay 单测：

1. 创建 window control session 返回 8 小时过期的 `deviceToken` 和 `expiresAt`。
2. 同一 `deviceToken` 第二个 mobile socket 返回 `session-conflict`。
3. 第二个页面没有 active `mobileConnectionId` 时，`workspace-bridge` / `mobile-view-state` 返回 `401 invalid-mobile-connection` 或 `409 session-conflict`。
4. active mobile 操作会滑动刷新 `expiresAt`，bootstrap 不刷新。
5. workspace bridge 创建后 mobile data socket 和 desktop bridge socket 能 attach。
6. mobile view state update 能按 window session 保存。
7. bootstrap 会通过 desktop control socket 拉快照；desktop 超时返回明确错误。

Desktop main 单测：

1. `start(windowId)` 不需要 workspace context。
2. `createWorkspaceBridge()` 能为 local workspace 创建 host。
3. `createWorkspaceBridge()` 能为 remote workspace 复用 `remoteSessionId` 找 target，并要求 `workspaceIdentity` 存在。
4. 切 bridge 会释放旧 host/data socket，但不重建设备 token。
5. `mobileViewState` 不影响桌面 active tab/task。
6. `window-bootstrap-request` 返回当前窗口同步的 workspace/task 快照。

Web/UI 单测：

1. URL 带 `remoteControlToken` 且未登录时，不渲染登录页，直接使用 `deviceToken` 获取窗口数据。
2. URL 不带 `remoteControlToken` 访问 `/web-remote` 时，仍按现有 Web OAuth 登录 / waiting page 逻辑处理。
3. web 先建立 window control socket 并保存 `mobileConnectionId`。
4. 同 workspace task 点击只更新 mobile active task，并携带 active connection header。
5. 跨 workspace task 点击请求 bridge，不跳新 `connectUrl`，并携带 active connection header。
6. remote task / workspace 使用 `workspaceIdentity` 作为隔离 key。
7. `connectRemote()` 在远控模式继续明确返回不支持。

集成验证：

1. 桌面开启远控，手机扫码进入默认 workspace。
2. 手机浏览器未登录也能通过二维码 token 进入远控页面。
3. 手机打开 `task-b`，桌面停留在 `task-a`。
4. 手机在 `task-b` 发送消息并产生结果。
5. 桌面手动切到 `task-b`，能看到手机端结果。
6. 第二个手机扫码同一 token，看到冲突。
7. 第二个手机直接调用 bridge/view-state HTTP API 被拒绝，旧手机不受影响。
8. remote workspace 下 bridge 创建和 task 打开正常，同路径不同远端不会串 task。

机械校验：

1. `pnpm lint`
2. `pnpm typecheck`

## 风险与取舍

1. 重新挂载 `Root` 切 workspace 比热切换 accessor 简单稳定，但跨 workspace 切换会有短暂 loading。
2. 第一版只保留一个 current bridge，避免多 workspace RPC 多路复用复杂度。
3. 不做强实时状态同步，靠持久化 reload 保证结果可见，降低对现有 Zustand/broadcast 架构的侵入。
4. `deviceToken` 是 8 小时滑动过期的短期 pairing token，二维码入口不要求登录；正式发布前仍需要补可选登录态增强校验、主动撤销、权限提示和 feature flag。

## 推荐落地顺序

优先实现窗口级 session 和单手机控制，再处理体验优化：

1. Relay + shared 类型先落地。
2. Desktop main 状态机切到 window runtime。
3. Web bootstrap 和 task 点击迁移。
4. 补桌面 task 切入 reload。
5. 更新文档和测试。

这样每一步都可以独立验证，并且可以保留旧 workspace 级入口一段时间用于回归对比。
