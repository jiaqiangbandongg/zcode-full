# BigModel OAuth Login Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace username/password login with BigModel OAuth, making login optional (non-blocking).

**Architecture:** New IOAuthService in host process handles OAuth business logic (state, PKCE, token exchange). Main process only registers custom protocol and routes deep links via state→windowId mapping. UI uses LoginDialog (from WelcomeScreen) with useOAuth hook. Auth state unified to Zustand store.

**Tech Stack:** Electron 41, React 19, Zustand 5, TypeScript, pnpm monorepo, shadcn UI

**Design Spec:** `docs/superpowers/specs/2026-03-31-bigmodel-oauth-login-design.md`

---

## File Structure

### New files
| File | Responsibility |
|---|---|
| `packages/shared/src/oauth.ts` | OAuth 配置常量 |
| `packages/services/src/oauth/oauth.ts` | IOAuthService 接口 + descriptor |
| `packages/services/src/oauth/oauthService.ts` | OAuthService Node.js 实现（state、PKCE、token exchange） |
| `packages/ui/src/hooks/useOAuth.ts` | OAuth 登录流程 hook（startLogin + UI 状态） |
| `packages/ui/src/hooks/useTokenRefresh.ts` | Token 刷新 hook（常驻 Root/App） |
| `packages/ui/src/WelcomeScreen.tsx` | 内容替换为 LoginDialog 组件（保留文件，改内容和导出名） |

### Modified files
| File | Change |
|---|---|
| `packages/shared/src/channels.ts` | ServiceChannels +OAuth; PlatformChannels +OpenExternal/OAuthRegisterState/OAuthCallback/RendererReady; -LoginSuccess/-Logout |
| `packages/shared/src/platform.ts` | IPlatformService +openExternal/registerOAuthState/onOAuthCallback/notifyRendererReady; -loginSuccess/-logout |
| `packages/shared/src/test-ids.ts` | 删除旧 TID，新增 OAuth TID |
| `packages/services/src/accessor.ts` | +oauthService |
| `packages/services/src/index.ts` | +IOAuthService 导出 |
| `packages/services/src/node.ts` | +createOAuthService 注册 |
| `packages/client/src/remoteServiceAccess.ts` | +oauthService proxy |
| `packages/desktop/src/host/index.ts` | Remote 模式 ServiceCollection +IOAuthService |
| `packages/client/src/globals.d.ts` | +openExternal/registerOAuthState/onOAuthCallback/notifyRendererReady; -loginSuccess/-logout |
| `packages/desktop/src/preload/index.ts` | +OAuth 方法; -loginSuccess/-logout |
| `packages/desktop/src/renderer/src/main.tsx` | platform 实现改造; -skipAuth/-loginSuccess/-logout |
| `packages/desktop/src/main/index.ts` | +protocol 注册/deep link/state 路由; -createLoginWindow/-hasAuthToken/-LoginSuccess/-Logout IPC |
| `packages/desktop/vite.config.ts` | 删除 login.html 入口 |
| `packages/desktop/electron-builder.config.js` | +protocols 配置 |
| `packages/ui/src/Root.tsx` | 删除 mock auth; useState→Zustand; +OAuth 回调监听; +useTokenRefresh; -WelcomeScreen/-skipAuth; +LoginDialog 状态管理 |
| `packages/ui/src/App.tsx` | 右上角：未登录显示登录按钮，已登录显示退出按钮; +onLogin prop |
| `packages/ui/src/store/index.ts` | 删除 MOCK_USER 相关；新增 oauthError 字段用于 Root→LoginDialog 错误传递 |
| `packages/web/src/main.tsx` | platform 适配（-loginSuccess/-logout; +空实现） |
| `AGENTS.md` | 更新 window.zcode 允许列表 |

### Deleted files
| File |
|---|
| `packages/desktop/src/renderer/src/login.tsx` |
| `packages/desktop/src/renderer/login.html` |
| `packages/desktop/test/e2e/pages/login.page.ts` |
| `packages/desktop/test/e2e/login.test.ts` |
| `packages/desktop/test/e2e/login-extended.test.ts` |

---

## Task 1: Shared Layer — Channels, OAuth Config, Platform Types, Test IDs

**Files:**
- Modify: `packages/shared/src/channels.ts`
- Create: `packages/shared/src/oauth.ts`
- Modify: `packages/shared/src/platform.ts`
- Modify: `packages/shared/src/test-ids.ts`
- Modify: `packages/shared/src/index.ts` (导出 oauth)

- [ ] **Step 1: 修改 channels.ts — 新增 OAuth channels，删除 LoginSuccess/Logout**

在 `packages/shared/src/channels.ts` 中：

ServiceChannels 新增 OAuth（在 FileWatcher 之后）：
```ts
  /** 文件系统监视服务 */
  FileWatcher: "file-watcher",
  /** OAuth 认证服务 */
  OAuth: "oauth",
} as const;
```

PlatformChannels 删除 LoginSuccess 和 Logout，新增 OAuth 相关：
```ts
export const PlatformChannels = {
  /** 打开系统目录选择框 */
  SelectDirectory: "zcode:select-directory",
  /** 检查目录是否已在其他窗口打开，如果是则激活该窗口 */
  ActivateOrSetWorkspace: "zcode:activate-or-set-workspace",
  /** 建立 SSH 远程连接 */
  ConnectRemote: "zcode:connect-remote",
  /** Renderer 日志转发到 main 进程统一存储 */
  Log: "zcode:log",
  /** Renderer → Main：同步当前窗口所有 tab 的 workspace 路径 */
  SyncWindowTabs: "zcode:sync-window-tabs",
  /** Main → Renderer：聚焦到指定 workspace 路径的 tab */
  FocusTab: "zcode:focus-tab",
  /** Main → Renderer：菜单触发新建 tab */
  NewTab: "zcode:new-tab",
  /** Main → Renderer：菜单触发新建任务 */
  NewTask: "zcode:new-task",
  /** Renderer → Main：把本地工作区加入系统最近文档 */
  AddRecentDocument: "zcode:add-recent-document",
  /** 获取进程指标（进程树形式） */
  GetProcessMetrics: "zcode:get-process-metrics",
  /** 打开进程监控窗口（其他窗口触发） */
  OpenProcessMonitor: "zcode:open-process-monitor",
  /** Renderer → Main：打开外部 URL（用于 OAuth 跳转浏览器） */
  OpenExternal: "zcode:open-external",
  /** Renderer → Main：上报 OAuth state 用于 deep link 路由 */
  OAuthRegisterState: "zcode:oauth-register-state",
  /** Main → Renderer：转发 deep link URL */
  OAuthCallback: "zcode:oauth-callback",
  /** Renderer → Main：renderer 已就绪，可接收缓存的 deep link */
  RendererReady: "zcode:renderer-ready",
} as const;
```

同步删除 PlatformChannelMap 中的 LoginSuccess 和 Logout 条目（删除 `channels.ts` 第 122-129 行）。

- [ ] **Step 2: 创建 oauth.ts — OAuth 配置常量**

创建 `packages/shared/src/oauth.ts`：
```ts
/**
 * BigModel OAuth 配置
 *
 * Desktop 是 public client，不使用 clientSecret，通过 PKCE 保障安全。
 * tokenUrl、userinfoUrl、appId 的实际值待 BigModel 确认后填入。
 */
export const BIGMODEL_OAUTH_CONFIG = {
  authorizeUrl: "https://bigmodel.cn/login",
  /** 待确认：token 交换端点 */
  tokenUrl: "https://bigmodel.cn/api/oauth/token",
  /** 待确认：用户信息端点（可选） */
  userinfoUrl: "https://bigmodel.cn/api/oauth/userinfo",
  /** 待确认：应用 ID */
  appId: "zcode-bigmodel-app",
  redirectUri: "zcode://bigmodel-auth/callback",
} as const;
```

- [ ] **Step 3: 修改 platform.ts — 删除 loginSuccess/logout，新增 OAuth 方法**

替换 `packages/shared/src/platform.ts` 为：
```ts
import type { SSHConnectOptions } from "./index.js";

/**
 * 平台操作接口 —— 替代直接访问 window.zcode
 *
 * 定义需要宿主环境（Electron main / Web server）参与的操作。
 * Desktop 和 Web 各自提供不同的实现，UI 层通过此接口统一消费。
 *
 * 设计原则：只放"必须穿越进程边界且不适合做成 RPC service"的操作，
 * 比如 native dialog、窗口生命周期控制等。
 * 业务服务（文件、终端、凭据等）走 IServiceAccessor 的 RPC 通道。
 */
export interface IPlatformService {
  /** 打开系统目录选择框，返回选中路径或 null */
  selectDirectory(): Promise<string | null>;

  /** 检查目录是否已在其他窗口打开；如果是则激活该窗口并切到对应 tab */
  activateOrSetWorkspace(path: string): Promise<{ activated: boolean }>;

  /** 建立 SSH 远程连接（Desktop: fork host process + SSH；Web: HTTP API） */
  connectRemote(options: SSHConnectOptions): Promise<{ success: boolean; error?: string }>;

  /** 打开外部 URL（用于 OAuth 跳转浏览器） */
  openExternal(url: string): void;

  /** 上报 OAuth state 给 main process，用于 deep link 路由 */
  registerOAuthState(state: string): void;

  /**
   * 注册 OAuth deep link 回调监听
   * @returns disposer 函数，调用后只移除当前回调
   */
  onOAuthCallback(callback: (url: string) => void): () => void;

  /** 通知 main process renderer 已就绪，触发缓存的冷启动 deep link 转发 */
  notifyRendererReady(): void;

  /** 同步当前窗口所有 tab 的 workspace 路径到 main 进程（用于跨窗口去重） */
  syncWindowTabs(paths: string[]): void;

  /** 注册 main 进程要求聚焦某个 workspace tab 的回调 */
  onFocusTab(handler: (path: string) => void): void;

  /** 注册 main 进程触发新建 tab 的回调 */
  onNewTab(handler: () => void): void;

  /** 注册 main 进程触发新建任务的回调 */
  onNewTask(handler: () => void): void;

  /** 让宿主环境把本地工作区加入系统最近文档列表 */
  addRecentDocument(path: string): void;
}
```

- [ ] **Step 4: 修改 test-ids.ts — 删除旧登录 TID，新增 OAuth TID**

删除 `TID_LOGIN_FORM`、`TID_USERNAME_INPUT`、`TID_PASSWORD_INPUT`、`TID_LOGIN_BUTTON`、`TID_LOGIN_ERROR`。

新增：
```ts
/** 右上角登录触发按钮 */
export const TID_LOGIN_TRIGGER = "login-trigger";
/** OAuth 弹窗内的登录按钮 */
export const TID_OAUTH_LOGIN_BUTTON = "oauth-login-button";
export const TID_OAUTH_CANCEL = "oauth-cancel";
export const TID_OAUTH_ERROR = "oauth-error";
```

- [ ] **Step 5: 修改 index.ts — 导出 oauth 模块**

在 `packages/shared/src/index.ts` 中添加导出：
```ts
export { BIGMODEL_OAUTH_CONFIG } from "./oauth.js";
```

- [ ] **Step 6: 验证**

Run: `cd packages/shared && pnpm typecheck && pnpm lint`

- [ ] **Step 7: 提交**

```bash
git add packages/shared/src/channels.ts packages/shared/src/oauth.ts packages/shared/src/platform.ts packages/shared/src/test-ids.ts packages/shared/src/index.ts
git commit -m "feat(shared): add OAuth channels, config, and platform types; remove login/logout"
```

---

## Task 2: IOAuthService Interface + Descriptor

**Files:**
- Create: `packages/services/src/oauth/oauth.ts`

- [ ] **Step 1: 创建 IOAuthService 接口**

创建 `packages/services/src/oauth/oauth.ts`：
```ts
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";
import type { UserInfo } from "@zcode/shared";

/**
 * OAuth 认证服务
 *
 * 在 host process 中运行，负责 OAuth 流程的全部业务逻辑：
 * state 生成、PKCE、token 交换、凭据存储。
 * Renderer 通过 RPC 调用，不直接接触 OAuth 细节。
 */
export interface IOAuthService {
  /**
   * 发起 OAuth：生成 state + PKCE，返回完整的 authorize URL 和 state
   * state 由 renderer 上报给 main process 用于 deep link 路由
   */
  startOAuth(): Promise<{ authorizeUrl: string; state: string }>;

  /**
   * 处理 OAuth 回调：校验 state，用 code + code_verifier 换 token，存凭据
   * @param url - 完整的 deep link URL (zcode://bigmodel-auth/callback?code=xxx&state=xxx)
   */
  handleCallback(url: string): Promise<UserInfo>;

  /**
   * 刷新 token
   * @param refreshToken - 当前的 refresh_token
   */
  refreshToken(refreshToken: string): Promise<void>;

  /** 清理所有 pending state 和超时定时器 */
  cancelPending(): Promise<void>;
}

export const IOAuthService = createServiceDescriptor<IOAuthService>(ServiceChannels.OAuth);
```

- [ ] **Step 2: 验证**

Run: `cd packages/services && pnpm typecheck`

- [ ] **Step 3: 提交**

```bash
git add packages/services/src/oauth/oauth.ts
git commit -m "feat(services): add IOAuthService interface and descriptor"
```

---

## Task 3: OAuthService Implementation

**Files:**
- Create: `packages/services/src/oauth/oauthService.ts`

- [ ] **Step 1: 实现 OAuthService**

创建 `packages/services/src/oauth/oauthService.ts`：
```ts
import { randomBytes, createHash } from "node:crypto";
import { BIGMODEL_OAUTH_CONFIG } from "@zcode/shared";
import type { UserInfo } from "@zcode/shared";
import type { IOAuthService } from "./oauth.js";
import type { ICredentialService } from "../credential/credential.js";

/** 凭据存储 key */
const AUTH_TOKEN_KEY = "auth_token";
const REFRESH_TOKEN_KEY = "refresh_token";
const USER_INFO_KEY = "user_info";

/** OAuth 超时时间（5 分钟） */
const OAUTH_TIMEOUT_MS = 5 * 60 * 1000;

interface PendingState {
  codeVerifier: string;
  timeout: NodeJS.Timeout;
}

/**
 * 生成 PKCE code_verifier（43-128 字符的随机 URL-safe 字符串）
 */
function generateCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * 根据 code_verifier 生成 code_challenge（S256 方式）
 */
function generateCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/**
 * OAuth 认证服务实现
 *
 * 在 host process 中运行，管理 OAuth 流程的完整生命周期。
 * 注入 ICredentialService 用于凭据存储。
 */
export class OAuthService implements IOAuthService {
  private pendingStates = new Map<string, PendingState>();

  constructor(private credentialService: ICredentialService) {}

  async startOAuth(): Promise<{ authorizeUrl: string; state: string }> {
    // 生成随机 state（防 CSRF）
    const state = randomBytes(32).toString("hex");

    // 生成 PKCE code_verifier 和 code_challenge
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);

    // 设置超时自动清理
    const timeout = setTimeout(() => {
      this.pendingStates.delete(state);
    }, OAUTH_TIMEOUT_MS);

    this.pendingStates.set(state, { codeVerifier, timeout });

    // 构建 authorize URL
    const params = new URLSearchParams({
      redirect: BIGMODEL_OAUTH_CONFIG.redirectUri,
      appId: BIGMODEL_OAUTH_CONFIG.appId,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });

    const authorizeUrl = `${BIGMODEL_OAUTH_CONFIG.authorizeUrl}?${params.toString()}`;

    return { authorizeUrl, state };
  }

  async handleCallback(url: string): Promise<UserInfo> {
    // 解析回调 URL
    const parsed = new URL(url);
    const code = parsed.searchParams.get("code");
    const state = parsed.searchParams.get("state");

    if (!code || !state) {
      throw new Error("OAuth 回调缺少 code 或 state 参数");
    }

    // 校验 state
    const pending = this.pendingStates.get(state);
    if (!pending) {
      throw new Error("OAuth state 不匹配或已过期");
    }

    // 匹配后立即删除（防重放）
    clearTimeout(pending.timeout);
    this.pendingStates.delete(state);

    // 用 code + code_verifier 换 token
    const tokenResponse = await fetch(BIGMODEL_OAUTH_CONFIG.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code,
        code_verifier: pending.codeVerifier,
        redirect_uri: BIGMODEL_OAUTH_CONFIG.redirectUri,
        app_id: BIGMODEL_OAUTH_CONFIG.appId,
        grant_type: "authorization_code",
      }),
    });

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text().catch(() => "unknown error");
      throw new Error(`Token 交换失败: ${tokenResponse.status} ${errorText}`);
    }

    const tokenData = (await tokenResponse.json()) as {
      access_token: string;
      refresh_token?: string;
      user_id?: string;
      username?: string;
    };

    // 存储 token
    await this.credentialService.save(AUTH_TOKEN_KEY, tokenData.access_token);
    if (tokenData.refresh_token) {
      await this.credentialService.save(REFRESH_TOKEN_KEY, tokenData.refresh_token);
    }

    // 尝试获取用户信息（可选）
    let userInfo: UserInfo = {
      id: tokenData.user_id ?? "unknown",
      username: tokenData.username ?? "user",
      displayName: tokenData.username ?? "User",
    };

    try {
      const userinfoResponse = await fetch(BIGMODEL_OAUTH_CONFIG.userinfoUrl, {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      if (userinfoResponse.ok) {
        const data = (await userinfoResponse.json()) as {
          id?: string;
          username?: string;
          display_name?: string;
        };
        userInfo = {
          id: data.id ?? userInfo.id,
          username: data.username ?? userInfo.username,
          displayName: data.display_name ?? data.username ?? userInfo.displayName,
        };
      }
    } catch {
      // 获取用户信息失败不阻塞登录
    }

    // 缓存用户信息
    await this.credentialService.save(USER_INFO_KEY, JSON.stringify(userInfo));

    return userInfo;
  }

  async refreshToken(refreshToken: string): Promise<void> {
    const response = await fetch(BIGMODEL_OAUTH_CONFIG.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        refresh_token: refreshToken,
        app_id: BIGMODEL_OAUTH_CONFIG.appId,
        grant_type: "refresh_token",
      }),
    });

    if (!response.ok) {
      throw new Error(`Token 刷新失败: ${response.status}`);
    }

    const data = (await response.json()) as {
      access_token: string;
      refresh_token?: string;
    };

    await this.credentialService.save(AUTH_TOKEN_KEY, data.access_token);
    if (data.refresh_token) {
      await this.credentialService.save(REFRESH_TOKEN_KEY, data.refresh_token);
    }
  }

  async cancelPending(): Promise<void> {
    for (const [state, pending] of this.pendingStates) {
      clearTimeout(pending.timeout);
      this.pendingStates.delete(state);
    }
  }
}

/**
 * 工厂函数：创建 OAuthService 实例
 *
 * @param credentialService - 凭据服务，用于存储 token
 */
export function createOAuthService(credentialService: ICredentialService): IOAuthService {
  return new OAuthService(credentialService);
}
```

- [ ] **Step 2: 验证**

Run: `cd packages/services && pnpm typecheck`

- [ ] **Step 3: 提交**

```bash
git add packages/services/src/oauth/oauthService.ts
git commit -m "feat(services): implement OAuthService with PKCE, state management, token exchange"
```

---

## Task 4: Service Wiring — Accessor, Index, Node, RemoteServiceAccess

**Files:**
- Modify: `packages/services/src/accessor.ts`
- Modify: `packages/services/src/index.ts`
- Modify: `packages/services/src/node.ts`
- Modify: `packages/client/src/remoteServiceAccess.ts`
- Modify: `packages/desktop/src/host/index.ts`

- [ ] **Step 1: 修改 accessor.ts — 新增 oauthService**

在 `packages/services/src/accessor.ts` 第 8 行后添加 import，第 19 行后添加字段：
```ts
import type { IOAuthService } from "./oauth/oauth.js";
```
```ts
  readonly oauthService: IOAuthService;
```

- [ ] **Step 2: 修改 index.ts — 导出 OAuth 模块**

在 `packages/services/src/index.ts` 末尾添加：
```ts
// OAuth service — IOAuthService is both a type (interface) and value (descriptor)
export { IOAuthService } from "./oauth/oauth.js";
```

- [ ] **Step 3: 修改 node.ts — 注册 OAuthService**

在 `packages/services/src/node.ts` 中：

添加 import：
```ts
import { IOAuthService } from "./oauth/oauth.js";
import { createOAuthService } from "./oauth/oauthService.js";
```

添加导出：
```ts
export { createOAuthService } from "./oauth/oauthService.js";
```

在 `createLocalServices` 函数的 ServiceCollection 链中添加：
```ts
    .register(IFileWatcherService, createFileWatcherService())
    .register(IOAuthService, createOAuthService(createCredentialService()));
```

注意：OAuthService 需要注入 credentialService。由于 `createLocalServices` 中各服务是独立创建的（不共享实例），这里单独创建一个 credentialService 给 OAuthService 使用。它们读写同一个文件所以数据一致。

- [ ] **Step 4: 修改 remoteServiceAccess.ts — 添加 oauthService proxy**

在 `packages/client/src/remoteServiceAccess.ts` 中：

添加 import：
```ts
import {
  ...existing imports,
  IOAuthService,
} from "@zcode/services";
```

添加字段和构造器中的初始化：
```ts
  readonly oauthService: IOAuthService;
```
```ts
    this.oauthService = ProxyChannel.toService<IOAuthService>(
      channelClient.getChannel(IOAuthService.channelName),
    );
```

- [ ] **Step 5: 修改 host/index.ts — Remote 模式注册 IOAuthService**

在 `packages/desktop/src/host/index.ts` 中：

Remote 模式的 ServiceCollection（`InitRemote` 分支）不走 `createLocalServices()`，需手动注册 IOAuthService。

添加 import：
```ts
import { IOAuthService } from "@zcode/services";
import { createOAuthService, createCredentialService } from "@zcode/services/node";
```

在 remote 模式的 `new ServiceCollection()` 链中添加（OAuth 是本地操作，不走 SSH）：
```ts
    .register(IFileWatcherService, connection.services.fileWatcherService)
    .register(IOAuthService, createOAuthService(createCredentialService()));
```

- [ ] **Step 6: 验证**

Run: `pnpm typecheck`

- [ ] **Step 6: 提交**

```bash
git add packages/services/src/accessor.ts packages/services/src/index.ts packages/services/src/node.ts packages/client/src/remoteServiceAccess.ts packages/desktop/src/host/index.ts
git commit -m "feat(services): wire IOAuthService into accessor, registry, remote proxy, and host process"
```

---

## Task 5: Preload Bridge + globals.d.ts

**Files:**
- Modify: `packages/desktop/src/preload/index.ts`
- Modify: `packages/client/src/globals.d.ts`

- [ ] **Step 1: 修改 preload/index.ts — 删除 loginSuccess/logout，新增 OAuth 方法**

替换 `packages/desktop/src/preload/index.ts` 为：
```ts
import { contextBridge, ipcRenderer } from "electron";
import type { SSHConnectOptions } from "@zcode/shared";
import { PlatformChannels, InternalChannels } from "@zcode/shared";

/**
 * Preload bridge —— 仅暴露需要 main 进程参与的平台操作
 *
 * 凭据管理已迁移到 host process 的 ICredentialService，
 * 通过 MessagePort RPC 访问，不再经过此 bridge。
 *
 * loginSuccess/logout 已删除：登录/登出不再涉及窗口切换，
 * 完全在 UI/Hook 层通过 credentialService + Zustand 处理。
 */
contextBridge.exposeInMainWorld("zcode", {
  connectRemote: (options: SSHConnectOptions) =>
    ipcRenderer.invoke(PlatformChannels.ConnectRemote, options),
  /** renderer 日志通过 IPC 传到 main 进程统一存储 */
  log: (level: "info" | "warn" | "error", args: unknown[]) =>
    ipcRenderer.send(PlatformChannels.Log, { level, args }),
  /** 打开系统目录选择框，返回选中路径或 null */
  selectDirectory: (): Promise<string | null> =>
    ipcRenderer.invoke(PlatformChannels.SelectDirectory),
  /** 检查目录是否已在其他窗口打开 */
  activateOrSetWorkspace: (path: string): Promise<{ activated: boolean }> =>
    ipcRenderer.invoke(PlatformChannels.ActivateOrSetWorkspace, path),
  /** 同步当前窗口所有 tab 的 workspace 路径到 main 进程 */
  syncWindowTabs: (paths: string[]) => ipcRenderer.send(PlatformChannels.SyncWindowTabs, paths),
  /** 注册 main 进程要求聚焦指定 workspace tab 的回调 */
  onFocusTab: (callback: (path: string) => void) => {
    ipcRenderer.on(PlatformChannels.FocusTab, (_event, path: string) => callback(path));
  },
  /** 注册 main 进程触发新建 tab 的回调 */
  onNewTab: (callback: () => void) => {
    ipcRenderer.on(PlatformChannels.NewTab, () => callback());
  },
  /** 注册 main 进程触发新建任务的回调 */
  onNewTask: (callback: () => void) => {
    ipcRenderer.on(PlatformChannels.NewTask, () => callback());
  },
  /** 让宿主环境把本地工作区加入系统最近文档列表 */
  addRecentDocument: (path: string) => ipcRenderer.send(PlatformChannels.AddRecentDocument, path),
  /** 打开外部 URL（用于 OAuth 跳转浏览器） */
  openExternal: (url: string) => ipcRenderer.send(PlatformChannels.OpenExternal, url),
  /** 上报 OAuth state 用于 deep link 路由 */
  registerOAuthState: (state: string) =>
    ipcRenderer.send(PlatformChannels.OAuthRegisterState, state),
  /** 注册 OAuth deep link 回调，返回 disposer */
  onOAuthCallback: (cb: (url: string) => void): (() => void) => {
    const handler = (_: unknown, url: string) => cb(url);
    ipcRenderer.on(PlatformChannels.OAuthCallback, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.OAuthCallback, handler);
  },
  /** 通知 main process renderer 已就绪 */
  notifyRendererReady: () => ipcRenderer.send(PlatformChannels.RendererReady),
});

/**
 * MessagePort 不能通过 contextBridge 传递（contextBridge 会把它包成 Proxy，
 * 丢失 addEventListener 等原生方法）。改用 window.postMessage 的 transfer
 * 机制将 MessagePort 原样传递到 renderer 的 window context 中。
 */
ipcRenderer.on(InternalChannels.ServicePort, (event) => {
  const [port] = event.ports;
  if (port) {
    window.postMessage(InternalChannels.ServicePort, "*", [port]);
  }
});
```

- [ ] **Step 2: 修改 globals.d.ts — 同步更新 window.zcode 类型**

替换 `packages/client/src/globals.d.ts` 为：
```ts
import type { SSHConnectOptions } from "@zcode/shared";

/**
 * window.zcode 类型定义 —— 仅包含需要 main 进程参与的平台操作
 *
 * 凭据管理已迁移到 ICredentialService（通过 RPC），不再经过此接口。
 * loginSuccess/logout 已删除：登录/登出不再涉及窗口切换。
 */
declare global {
  interface Window {
    zcode: {
      connectRemote(options: SSHConnectOptions): Promise<{ success: boolean; error?: string }>;
      /** renderer 日志通过 IPC 传到 main 进程统一存储 */
      log(level: "info" | "warn" | "error", args: unknown[]): void;
      /** 打开系统目录选择框，返回选中路径或 null */
      selectDirectory(): Promise<string | null>;
      /** 检查目录是否已在其他窗口打开 */
      activateOrSetWorkspace?(path: string): Promise<{ activated: boolean }>;
      /** 同步当前窗口所有 tab 的 workspace 路径到 main 进程 */
      syncWindowTabs(paths: string[]): void;
      /** 注册 main 进程要求聚焦指定 workspace tab 的回调 */
      onFocusTab(handler: (path: string) => void): void;
      /** 注册 main 进程触发新建 tab 的回调 */
      onNewTab(handler: () => void): void;
      /** 注册 main 进程触发新建任务的回调 */
      onNewTask(handler: () => void): void;
      /** 让宿主环境把本地工作区加入系统最近文档列表 */
      addRecentDocument(path: string): void;
      /** 打开外部 URL */
      openExternal(url: string): void;
      /** 上报 OAuth state 用于 deep link 路由 */
      registerOAuthState(state: string): void;
      /** 注册 OAuth deep link 回调，返回 disposer */
      onOAuthCallback(cb: (url: string) => void): () => void;
      /** 通知 main process renderer 已就绪 */
      notifyRendererReady(): void;
    };
  }
}
```

- [ ] **Step 3: 验证**

Run: `pnpm typecheck`

- [ ] **Step 4: 提交**

```bash
git add packages/desktop/src/preload/index.ts packages/client/src/globals.d.ts
git commit -m "feat(desktop): update preload bridge and globals.d.ts for OAuth; remove loginSuccess/logout"
```

---

## Task 6: Main Process — Protocol Registration, Deep Link, IPC

**Files:**
- Modify: `packages/desktop/src/main/index.ts`

这是最大的改动。需要在 main/index.ts 中：
1. 新增 custom protocol 注册和单实例锁
2. 新增 open-url / second-instance 监听
3. 新增 state→windowId 映射 + 冷启动缓存
4. 新增 OpenExternal / OAuthRegisterState / RendererReady IPC 监听
5. 删除 createLoginWindow 函数
6. 删除 hasAuthToken 函数及启动分支
7. 删除 LoginSuccess / Logout IPC 监听
8. 修改 activate 事件

- [ ] **Step 1: 在文件顶部（app.whenReady 之前）添加 protocol 注册和单实例锁**

在 `app.whenReady()` 调用之前添加：
```ts
// ============================================================================
// Custom Protocol 注册 + 单实例锁
// ============================================================================

// 注册 zcode:// 协议（必须在 ready 之前）
app.setAsDefaultProtocolClient("zcode");

// macOS: deep link 通过 open-url 事件传递（必须在 ready 之前注册）
app.on("open-url", (event, url) => {
  event.preventDefault();
  handleDeepLink(url);
});

// 单实例锁：确保只有一个实例运行
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
}

// Windows/Linux: 第二个实例启动时，deep link 通过命令行参数传入
app.on("second-instance", (_event, argv) => {
  const url = argv.find((arg) => arg.startsWith("zcode://"));
  if (url) handleDeepLink(url);

  // 聚焦已有窗口
  const win = BrowserWindow.getAllWindows()[0];
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});
```

- [ ] **Step 2: 添加 deep link 处理和 state→windowId 映射**

在文件中添加：
```ts
// ============================================================================
// OAuth deep link 路由
// ============================================================================

/** state → webContents.id 映射，用于把 deep link 路由到发起 OAuth 的窗口 */
const oauthStateToWindow = new Map<string, number>();

/** 冷启动时缓存的 deep link URL（仅冷启动场景使用，此时只有一个窗口在创建） */
let pendingDeepLinkUrl: string | null = null;

function handleDeepLink(url: string) {
  if (!url.startsWith("zcode://bigmodel-auth/callback")) return;

  let state: string | null = null;
  try {
    state = new URL(url).searchParams.get("state");
  } catch {
    logger.warn("[deep-link] 无法解析 URL:", url);
    return;
  }
  if (!state) return;

  const targetWindowId = oauthStateToWindow.get(state);
  const targetWindow = targetWindowId
    ? BrowserWindow.getAllWindows().find((w) => w.webContents.id === targetWindowId)
    : null;

  if (targetWindow) {
    targetWindow.webContents.send(PlatformChannels.OAuthCallback, url);
    oauthStateToWindow.delete(state);
  } else {
    // Renderer 尚未就绪（冷启动），缓存 URL，等 renderer ready 后再发送
    pendingDeepLinkUrl = url;
  }
}
```

- [ ] **Step 3: 在 app.whenReady() 内添加 OAuth IPC 监听**

在 `app.whenReady()` 回调中添加：
```ts
  // OAuth: 注册 state → windowId 映射
  ipcMain.on(PlatformChannels.OAuthRegisterState, (event, state: string) => {
    oauthStateToWindow.set(state, event.sender.id);

    // 5 分钟超时自动清理，防止残留脏映射
    setTimeout(() => oauthStateToWindow.delete(state), 5 * 60 * 1000);
  });

  // OAuth: 打开外部 URL
  ipcMain.on(PlatformChannels.OpenExternal, (_event, url: string) => {
    shell.openExternal(url);
  });

  // OAuth: renderer 就绪后发送缓存的冷启动 deep link
  ipcMain.on(PlatformChannels.RendererReady, (event) => {
    if (pendingDeepLinkUrl) {
      event.sender.send(PlatformChannels.OAuthCallback, pendingDeepLinkUrl);
      pendingDeepLinkUrl = null;
    }
  });

  // 窗口关闭时清理该窗口的所有 state 映射
  app.on("browser-window-created", (_, win) => {
    win.on("closed", () => {
      for (const [state, id] of oauthStateToWindow) {
        if (id === win.webContents.id) oauthStateToWindow.delete(state);
      }
    });
  });
```

- [ ] **Step 4: 删除 LoginSuccess / Logout IPC 监听**

删除 `main/index.ts` 中 `ipcMain.on(PlatformChannels.LoginSuccess, ...)` 和 `ipcMain.on(PlatformChannels.Logout, ...)` 两段代码（约第 832-847 行）。

- [ ] **Step 5: 删除 hasAuthToken 函数和凭据文件直读**

删除 `main/index.ts` 第 175-195 行的 `credentialsDir`、`credentialsFile`、`hasAuthToken()` 函数。

- [ ] **Step 6: 删除 createLoginWindow 函数**

删除 `createLoginWindow` 函数整体（约第 528-566 行）。

- [ ] **Step 7: 修改启动逻辑 — 始终创建主窗口**

将 `app.whenReady()` 中的启动分支替换：
```ts
  // 删除:
  // if (await hasAuthToken()) {
  //   createWindow();
  // } else {
  //   createLoginWindow();
  // }

  // 替换为：登录非强制，始终打开主窗口
  logger.info("[startup] 创建主窗口");
  createWindow();

  // Windows/Linux 冷启动：检查 process.argv 中的 deep link
  const protocolUrl = process.argv.find((arg) => arg.startsWith("zcode://"));
  if (protocolUrl) handleDeepLink(protocolUrl);
```

- [ ] **Step 8: 修改 activate 事件 — 不再检查 token**

将 `app.on("activate", ...)` 替换：
```ts
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
```

- [ ] **Step 9: 验证**

Run: `pnpm typecheck`

- [ ] **Step 10: 提交**

```bash
git add packages/desktop/src/main/index.ts
git commit -m "feat(desktop): add protocol registration, deep link routing; remove login window and auth gate"
```

---

## Task 7: Desktop Platform Implementation

**Files:**
- Modify: `packages/desktop/src/renderer/src/main.tsx`
- Modify: `packages/web/src/main.tsx`

- [ ] **Step 1: 修改 desktop main.tsx — 删除 loginSuccess/logout，添加 OAuth 方法，删除 skipAuth**

替换 `packages/desktop/src/renderer/src/main.tsx` 中的 `desktopPlatform` 对象和 Root 渲染：

```ts
// Desktop 平台操作实现：通过 preload bridge 调用 main 进程
const desktopPlatform: IPlatformService = {
  selectDirectory: () => window.zcode.selectDirectory(),
  activateOrSetWorkspace: (path) =>
    window.zcode.activateOrSetWorkspace?.(path) ?? Promise.resolve({ activated: false }),
  connectRemote: (options: SSHConnectOptions) => window.zcode.connectRemote(options),
  openExternal: (url) => window.zcode.openExternal(url),
  registerOAuthState: (state) => window.zcode.registerOAuthState(state),
  onOAuthCallback: (cb) => window.zcode.onOAuthCallback(cb),
  notifyRendererReady: () => window.zcode.notifyRendererReady(),
  syncWindowTabs: (paths) => window.zcode.syncWindowTabs(paths),
  onFocusTab: (handler) => window.zcode.onFocusTab(handler),
  onNewTab: (handler) => window.zcode.onNewTab(handler),
  onNewTask: (handler) => window.zcode.onNewTask(handler),
  addRecentDocument: (path) => window.zcode.addRecentDocument(path),
};
```

Root 渲染中删除 `skipAuth` prop：
```tsx
      <Root
        services={services}
        platform={desktopPlatform}
        isDesktop
        isMacDesktop={isMacDesktop}
        restoreSession={restoreSession}
        supportsSettings={supportsSettings}
        initialWorkspaceAbsPath={initialWorkspaceAbsPath}
      />
```

- [ ] **Step 2: 修改 web main.tsx — 删除 loginSuccess/logout，添加 OAuth 空实现**

将 `packages/web/src/main.tsx` 中的 `webPlatform` 替换：
```ts
const webPlatform: IPlatformService = {
  selectDirectory: () => Promise.resolve(null),
  activateOrSetWorkspace: () => Promise.resolve({ activated: false }),
  async connectRemote(options: SSHConnectOptions) {
    const res = await fetch("/api/connect-remote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(options),
    });
    const data = await res.json();
    if (!res.ok) {
      return { success: false, error: data.error || "Connection failed" };
    }
    window.open(`?remote=${data.id}`, "_blank");
    return { success: true };
  },
  // OAuth 本次只支持 Desktop，Web 端空实现
  openExternal: () => {},
  registerOAuthState: () => {},
  onOAuthCallback: () => () => {},
  notifyRendererReady: () => {},
  syncWindowTabs: () => {},
  onFocusTab: () => {},
  onNewTab: () => {},
  onNewTask: () => {},
  addRecentDocument: () => {},
};
```

- [ ] **Step 3: 验证**

Run: `pnpm typecheck`

- [ ] **Step 4: 提交**

```bash
git add packages/desktop/src/renderer/src/main.tsx packages/web/src/main.tsx
git commit -m "feat(desktop,web): update platform implementations for OAuth; remove loginSuccess/logout"
```

---

## Task 8: UI Hooks — useOAuth + useTokenRefresh

**Files:**
- Create: `packages/ui/src/hooks/useOAuth.ts`
- Create: `packages/ui/src/hooks/useTokenRefresh.ts`

- [ ] **Step 1: 创建 useOAuth hook**

创建 `packages/ui/src/hooks/useOAuth.ts`：
```ts
/**
 * useOAuth —— OAuth 登录流程 hook
 *
 * 仅负责发起登录和 UI 状态管理。
 * OAuth 回调监听在 Root/App 常驻层，不在此 hook 中。
 */
import { useState, useCallback } from "react";
import { useServices } from "./useServices.js";
import { usePlatform } from "./usePlatform.js";
import { logger } from "../logger.js";

export type OAuthStatus = "idle" | "waiting" | "error";

export function useOAuth() {
  const { oauthService } = useServices();
  const platform = usePlatform();
  const [status, setStatus] = useState<OAuthStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  const startLogin = useCallback(async () => {
    try {
      setStatus("waiting");
      setError(null);

      // 1. RPC 调用 oauthService.startOAuth() 获取 authorize URL 和 state
      const { authorizeUrl, state } = await oauthService.startOAuth();

      // 2. 上报 state 给 main process 用于 deep link 路由
      platform.registerOAuthState(state);

      // 3. 打开浏览器
      platform.openExternal(authorizeUrl);

      logger.info("[useOAuth] OAuth 流程已启动，等待浏览器回调");
    } catch (err) {
      logger.error("[useOAuth] 启动 OAuth 失败:", err);
      setStatus("error");
      setError(err instanceof Error ? err.message : "启动登录失败");
    }
  }, [oauthService, platform]);

  const cancel = useCallback(async () => {
    await oauthService.cancelPending();
    setStatus("idle");
    setError(null);
  }, [oauthService]);

  const reset = useCallback(() => {
    setStatus("idle");
    setError(null);
  }, []);

  /** 由 Root/App 层的回调监听器调用，更新 UI 状态 */
  const setOAuthError = useCallback((message: string) => {
    setStatus("error");
    setError(message);
  }, []);

  const setOAuthSuccess = useCallback(() => {
    setStatus("idle");
    setError(null);
  }, []);

  return { startLogin, cancel, reset, status, error, setOAuthError, setOAuthSuccess };
}
```

- [ ] **Step 2: 创建 useTokenRefresh hook**

创建 `packages/ui/src/hooks/useTokenRefresh.ts`：
```ts
/**
 * useTokenRefresh —— Token 刷新 hook（常驻层）
 *
 * 挂载在 Root 或 App 组件中，确保 401 刷新在任何时候都能工作。
 * 监听全局的 401 事件，调用 oauthService.refreshToken 刷新 token。
 */
import { useCallback } from "react";
import { useServices } from "./useServices.js";
import { logger } from "../logger.js";

const AUTH_TOKEN_KEY = "auth_token";
const REFRESH_TOKEN_KEY = "refresh_token";
const USER_INFO_KEY = "user_info";

export function useTokenRefresh() {
  const { oauthService, credentialService } = useServices();

  /** 尝试刷新 token，失败则清除凭证 */
  const tryRefresh = useCallback(async (): Promise<boolean> => {
    try {
      const refreshToken = await credentialService.load(REFRESH_TOKEN_KEY);
      if (!refreshToken) {
        logger.info("[useTokenRefresh] 无 refresh_token，需重新登录");
        return false;
      }

      await oauthService.refreshToken(refreshToken);
      logger.info("[useTokenRefresh] token 刷新成功");
      return true;
    } catch (err) {
      logger.error("[useTokenRefresh] token 刷新失败:", err);
      return false;
    }
  }, [oauthService, credentialService]);

  /** 清除所有凭证 */
  const clearCredentials = useCallback(async () => {
    await credentialService.delete(AUTH_TOKEN_KEY);
    await credentialService.delete(REFRESH_TOKEN_KEY);
    await credentialService.delete(USER_INFO_KEY);
  }, [credentialService]);

  return { tryRefresh, clearCredentials };
}
```

- [ ] **Step 3: 验证**

Run: `cd packages/ui && pnpm typecheck`

- [ ] **Step 4: 提交**

```bash
git add packages/ui/src/hooks/useOAuth.ts packages/ui/src/hooks/useTokenRefresh.ts
git commit -m "feat(ui): add useOAuth and useTokenRefresh hooks"
```

---

## Task 9: LoginDialog — Replace WelcomeScreen

**Files:**
- Modify: `packages/ui/src/WelcomeScreen.tsx` (内容完全替换为 LoginDialog 组件)

将 `WelcomeScreen.tsx` 的内容完全替换为 `LoginDialog` 组件。文件保留原路径，导出名改为 `LoginDialog`。

- [ ] **Step 1: 将 WelcomeScreen.tsx 改造为 LoginDialog**

替换 `packages/ui/src/WelcomeScreen.tsx` 的全部内容：
```tsx
/**
 * LoginDialog —— OAuth 登录弹窗
 *
 * 替代原来的用户名密码 WelcomeScreen。
 * 通过 useOAuth hook 驱动 OAuth 流程。
 */
import { useEffect } from "react";
import { LogInIcon, TriangleAlertIcon, Loader2Icon } from "lucide-react";
import { TID_OAUTH_LOGIN_BUTTON, TID_OAUTH_CANCEL, TID_OAUTH_ERROR } from "@zcode/shared";
import { useOAuth } from "./hooks/useOAuth.js";
import { useZCodeStore } from "./store/StoreProvider.js";
import { Alert, AlertDescription } from "./components/ui/alert.js";
import { Button } from "./components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog.js";
import { useZCodeIntl } from "./i18n/IntlProvider.js";

interface LoginDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function LoginDialog({ open, onOpenChange }: LoginDialogProps) {
  const { intl } = useZCodeIntl();
  const { startLogin, cancel, reset, status, error } = useOAuth();
  const user = useZCodeStore((s) => s.user);
  const oauthError = useZCodeStore((s) => s.oauthError);
  const setOAuthError = useZCodeStore((s) => s.setOAuthError);

  // Root 层 OAuth 回调失败时写入 Zustand oauthError → 弹窗显示错误
  useEffect(() => {
    if (oauthError && open) {
      reset();  // 重置 useOAuth 的 waiting 状态
      // oauthError 已在 store 中，下方 UI 会读取并显示
    }
  }, [oauthError, open, reset]);

  // OAuth 回调成功后 Root 层设置 user → 自动关闭弹窗
  useEffect(() => {
    if (user && open) {
      reset();
      setOAuthError(null);
      onOpenChange(false);
    }
  }, [user, open, reset, onOpenChange, setOAuthError]);

  const handleClose = (nextOpen: boolean) => {
    if (!nextOpen && status === "waiting") {
      cancel();
    }
    if (!nextOpen) {
      reset();
      setOAuthError(null);  // 清除 store 中的旧错误，避免下次打开仍显示
    }
    onOpenChange(nextOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {intl.formatMessage({ id: "login.title" })}
          </DialogTitle>
          <DialogDescription>
            {intl.formatMessage({ id: "login.description" })}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {status === "idle" && (
            <Button
              className="w-full"
              size="lg"
              data-testid={TID_OAUTH_LOGIN_BUTTON}
              onClick={startLogin}
            >
              <LogInIcon className="mr-2 size-4" />
              {intl.formatMessage({ id: "login.oauth.button" })}
            </Button>
          )}

          {status === "waiting" && (
            <div className="space-y-3">
              <div className="flex items-center justify-center gap-2 py-4 text-sm text-muted-foreground">
                <Loader2Icon className="size-4 animate-spin" />
                {intl.formatMessage({ id: "login.oauth.waiting" })}
              </div>
              <Button
                variant="outline"
                className="w-full"
                data-testid={TID_OAUTH_CANCEL}
                onClick={() => handleClose(false)}
              >
                {intl.formatMessage({ id: "login.oauth.cancel" })}
              </Button>
            </div>
          )}

          {(status === "error" || oauthError) && (
            <div className="space-y-3">
              <Alert variant="destructive" data-testid={TID_OAUTH_ERROR}>
                <TriangleAlertIcon className="size-4" />
                <AlertDescription>{oauthError || error}</AlertDescription>
              </Alert>
              <Button className="w-full" onClick={() => { setOAuthError(null); startLogin(); }}>
                {intl.formatMessage({ id: "login.oauth.retry" })}
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: 添加 i18n 消息**

在 zh-CN 和 en-US 的语言文件中添加以下 key：
```
login.title = 登录 / Login
login.description = 通过 BigModel 账号登录以获取完整功能 / Login with BigModel for full features
login.oauth.button = 通过 BigModel 登录 / Login with BigModel
login.oauth.waiting = 等待浏览器完成认证... / Waiting for browser authentication...
login.oauth.cancel = 取消 / Cancel
login.oauth.retry = 重新登录 / Retry Login
```

- [ ] **Step 3: 更新 UI 包的导出**

在 `packages/ui/src/index.ts` 中：
- 将 `WelcomeScreen` 的导出替换为 `LoginDialog`
- 如果有 `export { WelcomeScreen }` 改为 `export { LoginDialog }`

- [ ] **Step 3: 验证**

Run: `cd packages/ui && pnpm typecheck`

- [ ] **Step 4: 提交**

```bash
git add packages/ui/src/WelcomeScreen.tsx packages/ui/src/index.ts
git commit -m "feat(ui): replace WelcomeScreen with LoginDialog for BigModel OAuth"
```

---

## Task 10: Root.tsx Refactor + App.tsx Login Button

**Files:**
- Modify: `packages/ui/src/Root.tsx`
- Modify: `packages/ui/src/App.tsx`

这是 UI 层最核心的改动：
1. 删除 `MOCK_USER`、`AUTH_TOKEN_KEY`、`skipAuth`、mock 登录逻辑
2. `user` 状态从 `useState` 改为 Zustand store
3. 新增常驻的 OAuth 回调监听 + `notifyRendererReady`
4. 新增常驻的 `useTokenRefresh` hook
5. 登录 UI 从全屏 WelcomeScreen 改为 LoginDialog
6. logout 逻辑在 UI 层通过 credentialService + Zustand 处理
7. App.tsx 中 logout 按钮改为：未登录显示"登录"，已登录显示用户名 + "退出"

- [ ] **Step 1.5: 修改 store/index.ts — 新增 oauthError 字段**

在 `packages/ui/src/store/index.ts` 的 `ZCodeState` 接口中添加：
```ts
  /** OAuth 回调错误（Root 层写入，LoginDialog 读取） */
  oauthError: string | null;
  setOAuthError: (error: string | null) => void;
```

在 `create<ZCodeState>()` 的初始值中添加：
```ts
    oauthError: null,
    setOAuthError: (error: string | null) => set({ oauthError: error }),
```

- [ ] **Step 2: 重构 Root.tsx**

关键改动（不完整展示，实际需完整重写 RootInner）：

1. 删除 `MOCK_USER`、`AUTH_TOKEN_KEY` 常量
2. 删除 `skipAuth` prop 及相关逻辑
3. RootProps 中删除 `skipAuth`
4. 将 `const [user, setUser] = useState<UserInfo | null>(skipAuth ? MOCK_USER : null)` 改为：
   ```ts
   const user = useZCodeStore((s) => s.user);
   const setUser = useZCodeStore((s) => s.setUser);
   ```
5. 删除 `const [checked, setChecked] = useState(!!skipAuth)` — 改为根据 token 加载状态控制
6. 启动时的 token 检查改为：
   ```ts
   useEffect(() => {
     services.credentialService.load("auth_token").then((token) => {
       if (token) {
         // 尝试恢复缓存的用户信息
         services.credentialService.load("user_info").then((info) => {
           if (info) {
             try {
               setUser(JSON.parse(info));
             } catch {
               setUser({ id: "unknown", username: "user", displayName: "User" });
             }
           }
           setChecked(true);
         });
       } else {
         setChecked(true);
       }
     });
   }, [services.credentialService, setUser]);
   ```
7. 添加常驻的 OAuth 回调监听（在 RootInner 的 useEffect 中）：
   ```ts
   // 在组件顶层通过 hook 获取 setter
   const setOAuthError = useZCodeStore((s) => s.setOAuthError);

   useEffect(() => {
     const dispose = platform.onOAuthCallback(async (url) => {
       try {
         const userInfo = await services.oauthService.handleCallback(url);
         setUser(userInfo);
         setOAuthError(null);
         logger.info("[Root] OAuth 登录成功:", userInfo.username);
       } catch (err) {
         const message = err instanceof Error ? err.message : "登录失败";
         // 写入 Zustand store，LoginDialog 监听此字段显示错误
         setOAuthError(message);
         logger.error("[Root] OAuth 回调处理失败:", err);
       }
     });
     platform.notifyRendererReady();
     return dispose;
   }, [platform, services.oauthService, setUser, setOAuthError]);
   ```
8. 挂载 useTokenRefresh hook（当前为 stub，暴露 API 供后续 401 拦截集成）：
   ```ts
   // 注意：tryRefresh/clearCredentials 当前未被自动调用。
   // 后续需要在 API 调用层（如 oauthService 或 HTTP 拦截器）接入 401 → tryRefresh 的链路。
   // 本次只提供 hook API，实际的 401 自动刷新属于后续任务。
   const { tryRefresh, clearCredentials } = useTokenRefresh();
   ```
9. 删除 `handleLogin` 函数
10. 删除 `!user` 条件下渲染 WelcomeScreen 的分支 — 未登录时正常渲染主界面
11. 添加 LoginDialog 状态管理：
    ```ts
    const [loginDialogOpen, setLoginDialogOpen] = useState(false);
    ```
12. `handleLogout` 改为：
    ```ts
    const handleLogout = async () => {
      await services.credentialService.delete("auth_token");
      await services.credentialService.delete("refresh_token");
      await services.credentialService.delete("user_info");
      setUser(null);
    };
    ```
13. 在 App 组件传入 `onLogin`、`onLogout` 和 `user`：
    ```tsx
    <App
      ...
      onLogout={user ? handleLogout : undefined}
      onLogin={!user ? () => setLoginDialogOpen(true) : undefined}
      user={user}
      ...
    />
    ```
14. 在 RootInner 底部渲染 LoginDialog：
    ```tsx
    <LoginDialog open={loginDialogOpen} onOpenChange={setLoginDialogOpen} />
    ```

- [ ] **Step 2: 修改 App.tsx — 添加登录按钮，替代固定的 logout 按钮**

在 `packages/ui/src/App.tsx` 中：

1. Props 新增 `onLogin?: () => void` 和 `user?: UserInfo | null`：
   ```ts
   export function App({
     ...
     onLogout,
     onLogin,   // 新增
     user,      // 新增：用于显示用户名
     ...
   }: {
     onLogout?: () => void;
     onLogin?: () => void;   // 新增
     user?: UserInfo | null;  // 新增
     ...
   })
   ```

2. 将右上角的 logout 按钮区域改为（未登录显示登录按钮，已登录显示用户名 + 退出按钮）：
   ```tsx
   {onLogin ? (
     <button
       onClick={onLogin}
       data-testid={TID_LOGIN_TRIGGER}
       className="cursor-pointer rounded-lg bg-btn-alt-bg px-3 py-1 text-xs text-btn-alt-text transition hover:bg-surface-raised"
     >
       {intl.formatMessage({ id: "app.login" })}
     </button>
   ) : null}
   {onLogout ? (
     <>
       <span className="text-xs text-on-surface-muted">{user?.displayName}</span>
       <button
         onClick={onLogout}
         data-testid={TID_LOGOUT_BUTTON}
         className="cursor-pointer rounded-lg bg-btn-alt-bg px-3 py-1 text-xs text-btn-alt-text transition hover:bg-surface-raised"
       >
         {intl.formatMessage({ id: "app.logout" })}
       </button>
     </>
   ) : null}
   ```

3. 在 i18n 语言文件中添加 `app.login` key（登录 / Login）

- [ ] **Step 2: 验证**

Run: `pnpm typecheck && pnpm lint`

- [ ] **Step 3: 提交**

```bash
git add packages/ui/src/Root.tsx packages/ui/src/App.tsx packages/ui/src/store/index.ts
git commit -m "feat(ui): refactor Root.tsx + App.tsx + store — remove mock auth, add login button, add oauthError, unify to Zustand"
```

---

## Task 11: Cleanup — Delete Login Window, Update Vite Config, Migrate E2E Tests

**Files:**
- Delete: `packages/desktop/src/renderer/src/login.tsx`
- Delete: `packages/desktop/src/renderer/login.html`
- Delete: `packages/desktop/test/e2e/pages/login.page.ts`
- Delete: `packages/desktop/test/e2e/login.test.ts`
- Delete: `packages/desktop/test/e2e/login-extended.test.ts`
- Modify: `packages/desktop/vite.config.ts`

- [ ] **Step 1: 删除 login.tsx**

```bash
rm packages/desktop/src/renderer/src/login.tsx
```

- [ ] **Step 2: 删除 login.html**

```bash
rm packages/desktop/src/renderer/login.html
```

- [ ] **Step 3: 修改 vite.config.ts — 删除 login 入口**

在 `packages/desktop/vite.config.ts` 中，rollupOptions.input 删除 login 行：
```ts
        input: {
          index: resolve(__dirname, "src/renderer/index.html"),
          "process-monitor": resolve(__dirname, "src/renderer/process-monitor.html"),
        },
```

- [ ] **Step 4: 删除旧登录 e2e 测试文件**

```bash
rm packages/desktop/test/e2e/pages/login.page.ts
rm packages/desktop/test/e2e/login.test.ts
rm packages/desktop/test/e2e/login-extended.test.ts
```

这些测试依赖已删除的登录窗口、TID_USERNAME_INPUT 等元素，无法继续使用。
OAuth 登录的 e2e 测试需要 mock BigModel 端点和 deep link，属于后续单独任务。

注意：`seed-credentials.test.ts` 也引用了 `login.page.ts`，需要同步修改，移除对登录页的 import 和相关断言。

- [ ] **Step 5: 修改 seed-credentials.test.ts — 移除 login.page.ts 依赖**

检查 `packages/desktop/test/e2e/seed-credentials.test.ts` 中对 `login.page.ts` 的 import 和调用，删除或替换。该测试的核心逻辑是验证凭据种子，不依赖登录 UI 流程，只需移除登录页相关的断言。

- [ ] **Step 5: 验证**

Run: `pnpm typecheck && pnpm lint`

- [ ] **Step 6: 提交**

```bash
git add -A packages/desktop/src/renderer/src/login.tsx packages/desktop/src/renderer/login.html packages/desktop/vite.config.ts packages/desktop/test/e2e/pages/login.page.ts packages/desktop/test/e2e/login.test.ts packages/desktop/test/e2e/login-extended.test.ts packages/desktop/test/e2e/seed-credentials.test.ts
git commit -m "chore(desktop): remove login window, old login e2e tests, fix seed-credentials test"
```

---

## Task 12: Build Config + AGENTS.md Update

**Files:**
- Modify: `packages/desktop/electron-builder.config.js`
- Modify: `AGENTS.md`

- [ ] **Step 1: 修改 electron-builder.config.js — 添加 protocols 配置**

在 `packages/desktop/electron-builder.config.js` 中，mac 配置之前添加 protocols：
```js
  // OAuth deep link 协议注册（macOS 打包后需要 Info.plist 中声明 CFBundleURLTypes）
  protocols: [
    {
      name: "zcode",
      schemes: ["zcode"],
    },
  ],
  mac: {
```

- [ ] **Step 2: 修改 AGENTS.md — 更新 window.zcode 允许列表和描述**

在 `AGENTS.md` 第 92 行，更新"包括登录窗口"为"包括远程窗口"（删除登录窗口引用）。

第 99 行更新为：
```
* `window.zcode` 上只剩 `selectDirectory`、`activateOrSetWorkspace`、`connectRemote`、`log`、`openExternal`、`registerOAuthState`、`onOAuthCallback`、`notifyRendererReady`，不包含 credential
```

- [ ] **Step 3: 验证**

Run: `pnpm typecheck && pnpm lint`

- [ ] **Step 4: 提交**

```bash
git add packages/desktop/electron-builder.config.js AGENTS.md
git commit -m "chore: add protocol config for macOS deep link; update AGENTS.md"
```

---

## Task 13: Final Verification

- [ ] **Step 1: 全项目 typecheck**

Run: `pnpm typecheck`
Expected: 0 errors

- [ ] **Step 2: 全项目 lint**

Run: `pnpm lint`
Expected: 0 errors

- [ ] **Step 3: 构建验证**

Run: `pnpm build`
Expected: 成功构建

- [ ] **Step 4: 手动验证清单**

- 启动应用 → 直接进入主界面（不弹登录窗口）
- 右上角有「登录」按钮（`TID_LOGIN_TRIGGER`）→ 点击弹出 LoginDialog
- LoginDialog 中点击"通过 BigModel 登录"（`TID_OAUTH_LOGIN_BUTTON`）→ 浏览器打开 BigModel 登录页
- 完成认证后 → 应用自动回到已登录状态，LoginDialog 自动关闭
- 右上角显示用户 displayName + 「退出」按钮
- 认证失败时 → LoginDialog 显示错误信息，可重试
- 点击「退出」→ 回到未登录状态，右上角恢复为「登录」按钮
- 应用在未登录状态仍可正常使用
