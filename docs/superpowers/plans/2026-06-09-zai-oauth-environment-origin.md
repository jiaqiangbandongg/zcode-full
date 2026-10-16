# ZAI OAuth Environment Origin Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add environment-based ZAI OAuth origin configuration for production and test login entries.

**Architecture:** Keep OAuth paths fixed in code and let environment variables provide the origin and test client id. Host/service reads non-public `ZAI_OAUTH_ORIGIN` / `ZAI_OAUTH_CLIENT_ID`; Web reads public `VITE_ZAI_OAUTH_ORIGIN` / `VITE_ZAI_OAUTH_CLIENT_ID`; existing full URL overrides remain supported.

**Tech Stack:** TypeScript, Vite, Vitest.

---

## Chunk 1: OAuth Origin Configuration

### Task 1: Service Runtime Config

**Files:**
- Modify: `packages/services/src/oauth/providers/zaiProviderConfig.ts`
- Test: `packages/services/test/oauthService.test.ts`

- [ ] **Step 1: Write failing test**
  Add a test that constructs `OAuthService` with `ZAI_OAUTH_ORIGIN=https://chat.z.ai` and asserts `startOAuth("zai")` uses `https://chat.z.ai/api/oauth/authorize`.

- [ ] **Step 2: Run test to verify it fails**
  Run `pnpm exec vitest run packages/services/test/oauthService.test.ts -t "uses ZAI_OAUTH_ORIGIN"`.

- [ ] **Step 3: Implement origin-derived URLs**
  Add URL normalization and derive `authorizeUrl` / `userinfoUrl` from `ZAI_OAUTH_ORIGIN`, while preserving `ZAI_OAUTH_AUTHORIZE_URL` / `ZAI_OAUTH_USERINFO_URL` override priority.

- [ ] **Step 4: Run test to verify it passes**
  Run the same focused test.

### Task 2: Web/Vite Config

**Files:**
- Modify: `packages/web/src/auth/webZaiOAuthConfig.ts`
- Modify: `packages/web/vite.config.ts`
- Modify: `packages/desktop/tsup.config.ts`
- Modify: `packages/desktop/src/main/desktopRuntimeEnv.ts`
- Test: `packages/web/test/webAuthService.test.ts`
- Test: `packages/web/test/viteConfigLoad.test.ts`

- [ ] **Step 1: Write failing tests**
  Add tests asserting `VITE_ZAI_OAUTH_ORIGIN` and `VITE_ZAI_OAUTH_CLIENT_ID` change Web authorize URL and Vite defines the env values from local `development` mode.

- [ ] **Step 2: Run tests to verify they fail**
  Run focused Vitest commands for web auth and Vite config.

- [ ] **Step 3: Implement local development env loading**
  Load `VITE_` values in Web Vite config, load `.env.development` for desktop tsup and host process env, and define `import.meta.env.VITE_ZAI_OAUTH_ORIGIN` / `import.meta.env.VITE_ZAI_OAUTH_CLIENT_ID`.

- [ ] **Step 4: Implement Web origin-derived authorize URL**
  Read `import.meta.env.VITE_ZAI_OAUTH_ORIGIN` and derive `/api/oauth/authorize`.

- [ ] **Step 5: Verify**
  Run focused tests, then `pnpm typecheck` and `pnpm lint`.
