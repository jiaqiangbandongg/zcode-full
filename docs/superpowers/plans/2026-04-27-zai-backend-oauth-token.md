# ZAI Backend OAuth Token Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Change ZAI desktop OAuth login so the app opens z.ai authorization, exchanges callback `code/state` through `https://zcode.z.ai/api/v1/oauth/token`, and stores the returned backend JWT as the ZAI OAuth token.

**Architecture:** Keep the existing provider-aware OAuth architecture. The UI and `OAuthService` continue to use `ZaiProviderAdapter`; only the ZAI provider protocol mapping changes. BigModel and shared OAuth service behavior stay unchanged.

**Tech Stack:** TypeScript, Vitest, Electron deep link platform bridge, existing `ApiClient` / `readApiJson`, provider namespaced credentials.

---

## File Structure

- Modify `packages/services/test/oauthService.test.ts`
  - Update the ZAI authorize URL and token exchange assertions.
  - Add failure coverage for backend business errors and missing `data.token`.
- Modify `packages/services/src/oauth/providers/zaiProviderConfig.ts`
  - Change ZAI default authorize and token endpoints.
- Modify `packages/services/src/oauth/providers/zaiProviderAdapter.ts`
  - Replace direct ZAI token exchange with backend JSON token exchange.
  - Map backend JWT and user payload into `OAuthTokenSet` and `OAuthUserProfile`.
- Modify `docs/oauth/oauth-multi-provider-implementation.md`
  - Record the ZAI backend JWT exchange behavior.

## Task 1: Write Failing ZAI Backend OAuth Tests

**Files:**
- Modify: `packages/services/test/oauthService.test.ts:96`
- Modify: `packages/services/test/oauthService.test.ts:110`
- Test: `packages/services/test/oauthService.test.ts`

- [ ] **Step 1: Update the ZAI authorize URL test**

Replace the existing `builds zai authorize URL with provider-specific params` assertions with:

```ts
it("builds zai authorize URL with backend-token flow params", async () => {
  const service = createBigModelService();

  const { provider, authorizeUrl, state } = await service.startOAuth(ZAI_PROVIDER_ID);
  const parsed = new URL(authorizeUrl);

  expect(provider).toBe(ZAI_PROVIDER_ID);
  expect(parsed.origin + parsed.pathname).toBe("https://chat.z.ai/api/oauth/authorize");
  expect(parsed.searchParams.get("redirect_uri")).toBe(ZAI_OAUTH_PROVIDER_CONFIG.redirectUri);
  expect(parsed.searchParams.get("client_id")).toBe(ZAI_OAUTH_PROVIDER_CONFIG.appId);
  expect(parsed.searchParams.get("state")).toBe(state);
});
```

- [ ] **Step 2: Update the successful ZAI callback test**

In `stores zai credential keys and active provider after callback`, replace the mocked responses and expectations with a single backend token response:

```ts
fetchMock.mockResolvedValueOnce(
  new Response(
    JSON.stringify({
      code: 0,
      msg: "",
      data: {
        token: "zcode_backend_jwt",
        expires_in: 86400,
        user: {
          user_id: "zai-u-001",
          email: "user@example.com",
          avatar: "https://example.com/zai-avatar.png",
          created_at: "2026-04-27T10:00:00Z",
        },
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  ),
);
const result = await service.handleCallback(
  `zcode://zai-auth/callback?code=zai-code-001&state=${state}`,
);

expect(fetchMock).toHaveBeenCalledTimes(1);
expect(fetchMock).toHaveBeenNthCalledWith(
  1,
  ZAI_OAUTH_PROVIDER_CONFIG.tokenUrl,
  expect.objectContaining({
    method: "POST",
    headers: { "Content-Type": "application/json" },
  }),
);

const tokenCall = fetchMock.mock.calls[0];
if (!tokenCall) {
  throw new Error("missing token call");
}
const tokenInit = tokenCall[1] as RequestInit;
expect(JSON.parse(String(tokenInit.body))).toEqual({
  code: "zai-code-001",
  redirect_uri: ZAI_OAUTH_PROVIDER_CONFIG.redirectUri,
  state,
});

expect(result).toEqual({
  kind: "session",
  provider: ZAI_PROVIDER_ID,
  userInfo: {
    id: "zai-u-001",
    username: "user@example.com",
    displayName: "user@example.com",
    avatarUrl: "https://example.com/zai-avatar.png",
  },
});

expect(await credentialServiceStub.load("oauth:zai:access_token")).toBe("zcode_backend_jwt");
expect(await credentialServiceStub.load("oauth:zai:refresh_token")).toBeNull();
expect(await credentialServiceStub.load("oauth:zai:user_info")).toBe(
  JSON.stringify(result.userInfo),
);
expect(await credentialServiceStub.load("oauth:active_provider")).toBe(ZAI_PROVIDER_ID);
```

- [ ] **Step 3: Add a business-error test**

Add this test near the other ZAI callback tests:

```ts
it("fails zai backend token exchange when business code is not zero", async () => {
  const fetchMock = vi.fn<typeof fetch>();
  const service = createBigModelService({
    apiClient: createMockApiClient(fetchMock),
  });
  const { state } = await service.startOAuth(ZAI_PROVIDER_ID);

  fetchMock.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        code: 10001,
        msg: "invalid oauth code",
        data: null,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ),
  );

  await expect(
    service.handleCallback(`zcode://zai-auth/callback?code=bad-code&state=${state}`),
  ).rejects.toThrow(/invalid oauth code/);

  expect(await credentialServiceStub.load("oauth:zai:access_token")).toBeNull();
  expect(await credentialServiceStub.load("oauth:active_provider")).toBeNull();
});
```

- [ ] **Step 4: Add a missing-token test**

Add this test after the business-error test:

```ts
it("fails zai backend token exchange when response misses data token", async () => {
  const fetchMock = vi.fn<typeof fetch>();
  const service = createBigModelService({
    apiClient: createMockApiClient(fetchMock),
  });
  const { state } = await service.startOAuth(ZAI_PROVIDER_ID);

  fetchMock.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        code: 0,
        msg: "",
        data: {
          expires_in: 86400,
          user: {
            user_id: "zai-u-001",
            email: "user@example.com",
          },
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ),
  );

  await expect(
    service.handleCallback(`zcode://zai-auth/callback?code=zai-code-001&state=${state}`),
  ).rejects.toThrow(/data.token/);

  expect(await credentialServiceStub.load("oauth:zai:access_token")).toBeNull();
  expect(await credentialServiceStub.load("oauth:active_provider")).toBeNull();
});
```

- [ ] **Step 5: Add a direct adapter expires_in conversion test**

Update the import block to include the adapter:

```ts
import { ZaiProviderAdapter } from "../src/oauth/providers/zaiProviderAdapter.js";
```

Add this test near the other ZAI tests:

```ts
it("maps zai backend expires_in into OAuthTokenSet expiresAt", async () => {
  const fetchMock = vi.fn<typeof fetch>();
  const adapter = new ZaiProviderAdapter(
    {
      ...ZAI_OAUTH_PROVIDER_CONFIG,
      enabled: true,
    },
    createMockApiClient(fetchMock),
  );
  const now = 1_800_000_000_000;

  fetchMock.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        code: 0,
        msg: "",
        data: {
          token: "zcode_backend_jwt",
          expires_in: 86400,
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ),
  );

  await expect(
    adapter.exchangeToken(
      { code: "zai-code-001", state: "state-001" },
      {
        providerId: ZAI_PROVIDER_ID,
        state: "state-001",
        redirectUri: ZAI_OAUTH_PROVIDER_CONFIG.redirectUri,
        now: () => now,
      },
    ),
  ).resolves.toEqual({
    accessToken: "zcode_backend_jwt",
    expiresAt: now + 86400 * 1000,
  });
});
```

- [ ] **Step 6: Run the focused test and verify RED**

Run:

```bash
pnpm vitest run packages/services/test/oauthService.test.ts
```

Expected: FAIL. The failures should point to old ZAI authorize URL, form-encoded token body, old access token fields, and old extra userinfo request.

## Task 2: Implement ZAI Backend OAuth Token Exchange

**Files:**
- Modify: `packages/services/src/oauth/providers/zaiProviderConfig.ts:5`
- Modify: `packages/services/src/oauth/providers/zaiProviderAdapter.ts:13`
- Test: `packages/services/test/oauthService.test.ts`

- [ ] **Step 1: Update ZAI provider default endpoints**

In `packages/services/src/oauth/providers/zaiProviderConfig.ts`, change the default config to:

```ts
export const ZAI_OAUTH_PROVIDER_CONFIG: Omit<OAuthProviderRuntimeConfig, "appSecret"> = {
  id: ZAI_PROVIDER_ID,
  displayName: "Z.AI",
  enabled: true,
  order: 1,
  authorizeUrl: "https://chat.z.ai/api/oauth/authorize",
  tokenUrl: "https://zcode.z.ai/api/v1/oauth/token",
  userinfoUrl: "https://chat.z.ai/api/oauth/userinfo",
  appId: "client_P8X5CMWmlaRO9gyO-KSqtg",
  redirectUri: "zcode://zai-auth/callback",
  legacyRedirectUri: "zcode://oauth/callback",
};
```

- [ ] **Step 2: Replace ZAI token payload types**

In `packages/services/src/oauth/providers/zaiProviderAdapter.ts`, replace `ZaiTokenPayload` with:

```ts
interface ZaiBackendTokenPayload {
  code?: number;
  msg?: string;
  data?: {
    token?: string;
    expires_in?: number;
    user?: ZaiBackendUserPayload;
  } | null;
}

interface ZaiBackendUserPayload {
  user_id?: string;
  email?: string;
  avatar?: string;
  created_at?: string;
}
```

- [ ] **Step 3: Replace expiry helper and add backend response helpers**

Replace the old `normalizeExpiresAt` helper with:

```ts
function normalizeExpiresIn(raw: number | undefined, now: () => number): number | undefined {
  if (!raw || !Number.isFinite(raw)) {
    return undefined;
  }

  return now() + raw * 1000;
}

function toBackendUserProfile(user: ZaiBackendUserPayload | undefined): OAuthUserProfile {
  if (!user) {
    return {
      id: "unknown",
      username: "user",
      displayName: "User",
    };
  }

  const id = user.user_id ?? "unknown";
  const username = user.email ?? id;

  return {
    id,
    username,
    displayName: username,
    ...(user.avatar ? { avatarUrl: user.avatar } : {}),
  };
}
```

- [ ] **Step 4: Add a backend user cache field**

Inside `ZaiProviderAdapter`, below `readonly apiClient: ApiClient;`, add:

```ts
private lastBackendUserProfile: {
  state: string;
  profile: OAuthUserProfile;
} | null = null;
```

- [ ] **Step 5: Replace `exchangeToken` implementation**

Replace the full `exchangeToken` method with:

```ts
async exchangeToken(
  params: OAuthCallbackParams,
  context: OAuthProviderContext,
): Promise<OAuthTokenSet> {
  const tokenPayload = await readApiJson<ZaiBackendTokenPayload>(this.apiClient, this.config.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code: params.code,
      redirect_uri: context.redirectUri,
      state: context.state,
    }),
  });

  if (tokenPayload.code !== 0) {
    throw new Error(tokenPayload.msg?.trim() || "ZAI 后端 token 交换失败");
  }

  const accessToken = tokenPayload.data?.token;
  if (!accessToken) {
    throw new Error("Token 交换失败：响应缺少 data.token");
  }

  this.lastBackendUserProfile = {
    state: context.state,
    profile: toBackendUserProfile(tokenPayload.data?.user ?? undefined),
  };
  const expiresAt = normalizeExpiresIn(tokenPayload.data?.expires_in, context.now);

  return {
    accessToken,
    ...(expiresAt ? { expiresAt } : {}),
  };
}
```

- [ ] **Step 6: Make callback user mapping available to `fetchUserInfo`**

At the beginning of `fetchUserInfo`, before the remote `readApiJson` call, add:

```ts
if (this.lastBackendUserProfile?.state === _context.state) {
  const profile = this.lastBackendUserProfile.profile;
  this.lastBackendUserProfile = null;
  return profile;
}
```

Keep the old remote `fetchUserInfo` implementation after that branch for `restoreSession()` compatibility. The state guard prevents a ZAI subscription OAuth callback from leaving a stale cached profile that a later login or restore flow could consume.

- [ ] **Step 7: Run the focused test and verify GREEN**

Run:

```bash
pnpm vitest run packages/services/test/oauthService.test.ts
```

Expected: PASS for `packages/services/test/oauthService.test.ts`.

## Task 3: Update OAuth Documentation

**Files:**
- Modify: `docs/oauth/oauth-multi-provider-implementation.md:62`

- [ ] **Step 1: Update ZAI runtime config notes**

Under `## 3. 运行时配置说明（Host Process）`, after the ZAI environment variable list, add:

```md
ZAI 默认登录链路已切换为后端 JWT token 交换：

- 授权页：`https://chat.z.ai/api/oauth/authorize`
- token 交换：`https://zcode.z.ai/api/v1/oauth/token`
- 桌面端请求体：`{ code, redirect_uri, state }`
- 本地保存的 `oauth:zai:access_token` 是后端返回的 `data.token`
```

- [ ] **Step 2: Add an incremental section**

Before the current `## 4. 验证结果`, add:

```md
## 4. ZAI 后端 JWT 登录链路（增量）

ZAI OAuth 登录不再由桌面端直接请求三方 ZAI token 接口。桌面端只负责打开授权页、接收 `zcode://zai-auth/callback` deep link，并把 `code`、`redirect_uri`、`state` 传给后端 `https://zcode.z.ai/api/v1/oauth/token`。

后端完成 z.ai token 交换、userinfo 拉取、用户创建与 JWT 签发。客户端把响应中的 `data.token` 保存为 `oauth:zai:access_token`，把 `data.user` 映射为 `oauth:zai:user_info`，并把 `oauth:active_provider` 设置为 `zai`。
```

Then renumber these existing headings exactly:

```md
## 4. 验证结果
```

to:

```md
## 5. 验证结果
```

and continue increasing each later top-level numeric heading by one, so old `## 7. OAuth 后预置模型供应商补齐（ZAI）` becomes `## 8. OAuth 后预置模型供应商补齐（ZAI）`.

- [ ] **Step 3: No focused doc test required**

This is a documentation-only task. Verification happens in Task 4.

## Task 4: Run Required Verification

**Files:**
- Verify all changed files.

- [ ] **Step 1: Run focused OAuth tests**

Run:

```bash
pnpm vitest run packages/services/test/oauthService.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run typecheck**

Run:

```bash
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 3: Run lint**

Run:

```bash
pnpm lint
```

Expected: PASS.

- [ ] **Step 4: Inspect git diff**

Run:

```bash
git diff -- packages/services/test/oauthService.test.ts packages/services/src/oauth/providers/zaiProviderConfig.ts packages/services/src/oauth/providers/zaiProviderAdapter.ts docs/oauth/oauth-multi-provider-implementation.md
```

Expected: diff only contains the ZAI backend OAuth token changes and documentation.

## Self-Review

- Spec coverage: the plan covers authorize URL, backend token URL, JSON request body, JWT persistence, user mapping, business errors, missing token errors, docs, `typecheck`, and `lint`.
- Placeholder scan: no unfinished placeholders or unspecified implementation steps are intentionally left.
- Type consistency: test payload names use backend response fields (`token`, `expires_in`, `user_id`, `email`, `avatar`); implementation maps those into existing `OAuthTokenSet` and `OAuthUserProfile`.
