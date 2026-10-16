# SelectedKey Migration E2E Network Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 I32～I34 使用无 active OAuth 的本地 fake credentials fixture，避免 App reload 请求真实 Z.AI 网络。

**Architecture:** 用纯函数根据当前 worker spec 选择凭据：selectedKey migration 只保留 legacy fake `auth_token`，其他 spec 继续合并默认 restored OAuth 凭据。WDIO 保持 readiness/recovery 特殊 fixture 的既有优先级。

**Tech Stack:** TypeScript、Vitest、WebdriverIO、Electron E2E。

## Global Constraints

- 保留 I32～I34 的真实 App reload 和本地 `setting.json` 迁移。
- 不修改产品 OAuth/provider 网络逻辑。
- 不改变其他 E2E worker 的默认 OAuth fixture。
- Shell 命令使用 `rtk`，编辑使用 `apply_patch`。

---

### Task 1: 用 TDD 定义 credentials fixture 选择

**Files:**

- Create: `packages/desktop/test/e2e/helpers/e2e-startup-credentials.ts`
- Create: `packages/desktop/test/e2eStartupCredentials.test.ts`

**Interfaces:**

- Consumes: `workerSpecsContain(specs: string[], marker: string): boolean`
- Produces: `createE2EStartupCredentialSeed(params): Record<string, string>`

- [ ] 新增单测：目标 spec 必须得到 `{ auth_token: "fake-auth-token" }`，普通 spec 必须保留 restored OAuth 字段。
- [ ] 运行 `rtk pnpm exec vitest run packages/desktop/test/e2eStartupCredentials.test.ts`，确认 helper 不存在导致 RED。
- [ ] 实现：命中 `conversation-session-model-provider-selected-key-migration.test.ts` 时只返回 legacy seed，否则返回 legacy seed 与 restored OAuth seed 的合并结果。
- [ ] 重跑 focused test，确认 2 个测试通过。

实现签名：

```ts
export function createE2EStartupCredentialSeed(params: {
  specs?: string[];
  legacyAuthToken: string;
  restoredOAuthCredentials: Record<string, string>;
}): Record<string, string>;
```

### Task 2: WDIO 接入并验证真实 E2E

**Files:**

- Modify: `packages/desktop/wdio.conf.ts`
- Verify: `packages/desktop/test/e2e/conversation-session/conversation-session-model-provider-selected-key-migration.test.ts`

**Interfaces:**

- Consumes: `createE2EStartupCredentialSeed`
- Produces: I32～I34 worker 的 `credentials.json` 不含 OAuth active provider/access token/user info/JWT

- [ ] 在 WDIO 默认 credential 分支调用纯函数；readiness `{}` 与 corrupt recovery fixture 的优先级不变。
- [ ] 运行 focused Vitest 与 `@zcode/desktop typecheck:e2e`。
- [ ] 运行 I32～I34 整个 spec，要求 3/3 通过。
- [ ] 在该 run 日志中搜索 `model-provider.refreshCodingPlanApiKey`、`billing/balance`、`api/biz/customer/getCustomerInfo`，要求无匹配。
- [ ] 运行 `rtk pnpm typecheck`、`rtk pnpm lint`、`rtk git diff --check`。
- [ ] 提交 `fix(desktop-e2e): isolate selected-key migration from network`。
