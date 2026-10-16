import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { HttpClientPort, HttpClientResponse, SessionEvent } from "@zcode/contracts";
import {
  createCliOAuthClient,
  createSharedZCodeCredentialStore,
  SHARED_ZCODE_CREDENTIAL_KEYS as keys,
} from "@zcode/adapters/auth";
import { NodePersonalProviderConfigRepository } from "@zcode/provider-node";
import {
  loginZCodeCli,
  loginBigmodelCodingPlan,
  type LoginZCodeCliOptions,
} from "../../bootstrap/src/auth-login.js";
import { startProcessProviderRegistryRuntime } from "../../bootstrap/src/app/process-provider-registry-runtime.js";
import { listRegistryBackedModels } from "../../bootstrap/src/app/provider-registry-selection.js";
import {
  createStandaloneAccountIdentityFromSecret,
  resolveStandaloneCodingPlanProvider,
  standaloneAccountAuthSourceCredentialKey,
  standaloneAccountIdentityCredentialKey,
  standaloneAccountProviderCredentialKey,
} from "../../bootstrap/src/app/standalone-account-provider-runtime.js";
import { createTuiSubmitPrompt } from "../src/tui-prompt-handler.js";
import { createCliModeState } from "../src/tui-command-state.js";
import type { CommandCenterApp } from "../src/command-center.js";
import type { RunDependencies } from "../src/cli-types.js";
import type { TuiOptions } from "../../tui/src/types.js";
import { runLoginCommand } from "../src/login-command.js";

const authorizeUrl = "https://login.example.test/authorize?state=test-state";
const pollToken = "test-private-poll-token";
const ready = (providerId: "zai" | "bigmodel") => ({
  status: "ready",
  token: "test-backend-jwt",
  user: { user_id: "test-account", name: "Test User" },
  [providerId]:
    providerId === "zai"
      ? { access_token: "test-oauth-token" }
      : { accessToken: "test-business-token", refreshToken: "test-refresh-token" },
});
const TEST_PROJECT_MATERIAL = {
  token: "test-project-token",
  apiKeyId: "test-api-key-id",
  organizationId: "test-org",
  projectId: "test-project",
};
function response(data: unknown, status = 200): HttpClientResponse {
  const body = new TextEncoder().encode(JSON.stringify({ code: 0, data }));
  return {
    url: "https://example.test",
    status,
    statusText: "test",
    headers: {},
    body,
    bytes: body.length,
    durationMs: 0,
  };
}
async function fixture(t: TestContext, providerId: "zai" | "bigmodel" = "bigmodel") {
  const dir = await mkdtemp(join(tmpdir(), "zcode-login-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const personalFile = join(dir, "provider_config.json");
  const personal = new NodePersonalProviderConfigRepository({
    filePath: personalFile,
    pollingIntervalMs: false,
  });
  await personal.update((current) => current);
  personal.dispose();
  const env = {
    ZCODE_DATA_BASE_DIR: dir,
    ZCODE_CREDENTIAL_SECRET: "test-encryption-key",
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: resolve(
      import.meta.dirname,
      "../../../../../config/provider/zcode-builtin.json",
    ),
    ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: personalFile,
  };
  const store = createSharedZCodeCredentialStore({ env });
  let now = 1_000_000;
  const sleeps: number[] = [];
  const requests: Parameters<HttpClientPort["request"]>[0][] = [];
  const f = {
    env,
    store,
    sleeps,
    requests,
    advance: (ms: number) => {
      now += ms;
    },
    poll: async (_signal?: AbortSignal): Promise<HttpClientResponse> => response(ready(providerId)),
    options: {} as LoginZCodeCliOptions,
  };
  const httpClient: HttpClientPort = {
    async request(request, options) {
      requests.push(request);
      assert.equal(request.headers?.Authorization, `Bearer ${pollToken}`);
      assert.ok(options?.signal);
      if (request.method === "POST") {
        assert.deepEqual(JSON.parse(new TextDecoder().decode(request.body)), {
          provider: providerId,
        });
        return response({
          flow_id: "flow/with space",
          authorize_url: authorizeUrl,
          expires_at: now / 1000 + 120,
          poll_interval_sec: 1,
        });
      }
      assert.match(request.url, /\/oauth\/cli\/poll\/flow%2Fwith%20space$/);
      return f.poll(options?.signal);
    },
  };
  f.options = {
    env,
    credentialStore: store,
    providerId,
    httpClient,
    noBrowser: true,
    pollToken,
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
    // OAuth 登录只解析项目访问材料，不再落盘派生 API Key（staging 9af2a442d3 改为请求期换取 Token）。
    apiKeyResolver: {
      async resolveMaterial(input, options) {
        assert.equal(input.family, providerId);
        assert.equal(
          input.accessToken,
          providerId === "zai" ? "test-oauth-token" : "test-business-token",
        );
        assert.ok(options?.signal);
        return TEST_PROJECT_MATERIAL;
      },
    } as unknown as LoginZCodeCliOptions["apiKeyResolver"],
  };
  return f;
}

for (const providerId of ["zai", "bigmodel"] as const) {
  test(`${providerId} browser polling persists credentials and refreshes the running Registry`, async (t) => {
    const f = await fixture(t, providerId);
    const runtime = await startProcessProviderRegistryRuntime(f.env, {
      standalone: { credentialStore: f.store },
    });
    t.after(() => runtime.dispose());
    const configured = await resolveStandaloneCodingPlanProvider(providerId, f.env);
    assert.equal(runtime.runtime.registryService.getProvider(configured.providerId), undefined);
    let attempts = 0;
    f.poll = async () => {
      attempts++;
      if (attempts === 1) return response({ status: "pending" });
      if (attempts === 2) throw new TypeError("test temporary network error");
      if (attempts === 3)
        return { ...response(null, 503), body: new TextEncoder().encode("unavailable") };
      if (attempts === 4) return response(null, 429);
      return response(ready(providerId));
    };
    const result =
      providerId === "bigmodel"
        ? await loginBigmodelCodingPlan(f.options)
        : await loginZCodeCli(f.options);
    assert.equal(result.providerId, providerId);
    assert.equal(result.user.user_id, "test-account");
    assert.equal(attempts, 5);
    assert.deepEqual(f.sleeps, [1000, 1000, 1000, 1000]);
    assert.equal(await f.store.load(keys.zcodeJwtToken), "test-backend-jwt");
    // Z.ai 以账号用户 ID 为连接身份；BigModel 以组织与项目的稳定摘要为连接身份。
    const expectedIdentity =
      providerId === "zai"
        ? "test-account"
        : createStandaloneAccountIdentityFromSecret(
            JSON.stringify([TEST_PROJECT_MATERIAL.organizationId, TEST_PROJECT_MATERIAL.projectId]),
          );
    assert.equal(
      await f.store.load(standaloneAccountIdentityCredentialKey(configured.providerId)),
      expectedIdentity,
    );
    assert.equal(
      await f.store.load(standaloneAccountAuthSourceCredentialKey(configured.providerId)),
      "oauth",
    );
    assert.equal(
      await f.store.load(
        standaloneAccountProviderCredentialKey({
          providerId: configured.providerId,
          accountIdentity: expectedIdentity,
        }),
      ),
      null,
    );
    assert.ok(runtime.runtime.registryService.getProvider(configured.providerId)?.models.length);
    assert.deepEqual(await runtime.modelSelectionConfigRepository.read(), {
      providerId: configured.providerId,
      modelId: configured.modelId,
    });
    if (providerId === "bigmodel")
      assert.equal(await f.store.load(keys.bigmodelRefreshToken), "test-refresh-token");
  });
}

test("OAuth init does not require an echoed poll secret and accepts both BigModel token spellings", async () => {
  for (const token of [
    { access_token: "token", refresh_token: "refresh" },
    { accessToken: "token", refreshToken: "refresh" },
  ]) {
    const client = createCliOAuthClient({
      providerId: "bigmodel",
      httpClient: {
        async request(request) {
          return request.method === "POST"
            ? response({
                flow_id: "flow",
                authorize_url: authorizeUrl,
                expires_at: 12345,
                poll_interval_sec: 1,
              })
            : response({ ...ready("bigmodel"), bigmodel: token });
        },
      },
    });
    assert.equal(Object.hasOwn(await client.init({ pollToken }), "poll_token"), false);
    const result = await client.poll({ flowId: "flow", pollToken });
    assert.equal(result.status, "ready");
    if (result.status === "ready") assert.equal(result.refreshToken, "refresh");
  }
});

for (const failure of ["failed", "unauthorized", "malformed"] as const) {
  test(`terminal polling failure ${failure} does not write credentials or retry`, async (t) => {
    const f = await fixture(t);
    f.poll = async () =>
      failure === "unauthorized"
        ? response(null, 401)
        : response(
            failure === "failed" ? { status: "failed" } : { ...ready("bigmodel"), bigmodel: {} },
          );
    await assert.rejects(loginBigmodelCodingPlan(f.options));
    assert.equal(await f.store.load(keys.activeProvider), null);
    assert.equal(f.sleeps.length, 0);
  });
}

test("cancelling in-flight polling ignores a late ready response", { timeout: 2000 }, async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  let finish!: (data: HttpClientResponse) => void;
  let started!: () => void;
  const polling = new Promise<void>((resolve) => {
    started = resolve;
  });
  let requestSignal: AbortSignal | undefined;
  f.poll = (signal) => {
    requestSignal = signal;
    started();
    return new Promise((resolve) => {
      finish = resolve;
    });
  };
  const login = loginBigmodelCodingPlan({ ...f.options, abortSignal: controller.signal });
  await polling;
  controller.abort(new Error("test login cancelled"));
  await assert.rejects(login, /test login cancelled/);
  assert.equal(requestSignal?.aborted, true);
  finish(response(ready("bigmodel")));
  await Promise.resolve();
  assert.equal(await f.store.load(keys.activeProvider), null);
});

test("login timeout interrupts an unresponsive transport", { timeout: 2000 }, async (t) => {
  const f = await fixture(t);
  f.poll = () => new Promise(() => {});
  await assert.rejects(loginBigmodelCodingPlan({ ...f.options, timeoutMs: 30 }), {
    code: "auth_timeout",
  });
  assert.equal(await f.store.load(keys.activeProvider), null);
});

test("a response received after flow expiry is not persisted", async (t) => {
  const f = await fixture(t);
  f.poll = async () => {
    f.advance(121_000);
    return response(ready("bigmodel"));
  };
  await assert.rejects(loginBigmodelCodingPlan(f.options), { code: "auth_timeout" });
  assert.equal(await f.store.load(keys.activeProvider), null);
});

test("cancellation during API key resolution does not save the login", async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  await assert.rejects(
    loginBigmodelCodingPlan({
      ...f.options,
      abortSignal: controller.signal,
      apiKeyResolver: {
        async resolveMaterial() {
          controller.abort(new Error("cancel before save"));
          return TEST_PROJECT_MATERIAL;
        },
      } as unknown as LoginZCodeCliOptions["apiKeyResolver"],
    }),
    /cancel before save/,
  );
  assert.equal(await f.store.load(keys.activeProvider), null);
});

test("browser failure keeps authorization URL available and polling completes", async (t) => {
  const f = await fixture(t);
  let shown = "";
  const result = await loginBigmodelCodingPlan({
    ...f.options,
    noBrowser: false,
    onAuthorizeUrl: (data) => {
      shown = data.authorize_url;
    },
    openBrowser: async () => ({
      command: "test-open",
      opened: false,
      reason: "test headless host",
    }),
  });
  assert.equal(shown, authorizeUrl);
  assert.equal(result.browser?.opened, false);
});

test(
  "TUI renders the login URL in the current session and refreshes models after authorization",
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t);
    const runtime = await startProcessProviderRegistryRuntime(f.env, {
      standalone: { credentialStore: f.store },
    });
    let authorize!: () => void;
    const authorization = new Promise<void>((resolve) => {
      authorize = resolve;
    });
    let urlShown!: () => void;
    const authorizationShown = new Promise<void>((resolve) => {
      urlShown = resolve;
    });
    f.poll = async () => {
      await authorization;
      return response(ready("bigmodel"));
    };
    const app = {
      sessionId: "login-session",
      traceId: "login-trace",
      getModel: () => "",
      getLocale: () => "en-US",
      listModels: () => listRegistryBackedModels(runtime.runtime.registryService),
      listThoughtLevels: () => [],
    } as unknown as CommandCenterApp;
    const handler = createTuiSubmitPrompt(
      {
        env: f.env,
        cwd: () => process.cwd(),
        skipUserConfig: true,
        loadDotenv: () => ({ keys: [], loaded: false, path: "" }),
        createZCodeApp: async () => app,
        startProcessProviderRegistryRuntime: async () => runtime,
        loginBigmodelCodingPlan: (options: Parameters<typeof loginBigmodelCodingPlan>[0]) =>
          loginBigmodelCodingPlan({
            ...f.options,
            ...options,
            onAuthorizeUrl: async (data) => {
              await options?.onAuthorizeUrl?.(data);
              urlShown();
            },
          }),
      } as unknown as RunDependencies,
      createCliModeState(),
      "test",
    );
    t.after(() => handler.close?.());
    const React = await import("react");
    const { createTestRenderer } = await import("@mbears/opentui-core/testing");
    const { createRoot } = await import("@mbears/opentui-react");
    const { CodeRenderable } = await import("@mbears/opentui-core");
    const { TuiApp } = await import("../../tui/src/app.js");
    const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const previous = environment.IS_REACT_ACT_ENVIRONMENT;
    environment.IS_REACT_ACT_ENVIRONMENT = true;
    const terminal = await createTestRenderer({
      width: 120,
      height: 45,
      screenMode: "alternate-screen",
      useThread: false,
    });
    const root = createRoot(terminal.renderer);
    let loginCompletion: ReturnType<typeof handler> | undefined;
    const seenEvents: SessionEvent[] = [];
    const options: TuiOptions = {
      noColor: true,
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      getMainSessionId: () => app.sessionId,
      locale: "en-US",
      submitPrompt: (input, options) => {
        loginCompletion = handler(input, {
          ...options,
          onEvent: async (event) => {
            seenEvents.push(event);
            await options.onEvent?.(event);
          },
        });
        return loginCompletion;
      },
      ...(await handler.getSessionMetadata!()),
      listModelOptions: handler.listModelOptions,
    };
    const action = async (run: () => void | Promise<void>) => {
      await React.act(async () => {
        await run();
      });
      const waitForHighlights = async (node: typeof terminal.renderer.root): Promise<void> => {
        if (node instanceof CodeRenderable) await node.highlightingDone;
        await Promise.all(
          node.getChildren().map((child) => waitForHighlights(child as typeof node)),
        );
      };
      await React.act(async () => {
        await terminal.renderOnce();
        await waitForHighlights(terminal.renderer.root);
        await terminal.renderOnce();
      });
    };
    try {
      await action(() =>
        root.render(
          React.createElement(TuiApp, {
            options,
            onExit() {},
            hasCopyableSelection: () => false,
            copySelection: async () => ({ kind: "empty" as const }),
          }),
        ),
      );
      await action(() => terminal.mockInput.typeText("/login bigmodel-coding-plan"));
      await action(async () => {
        terminal.mockInput.pressEnter();
        await authorizationShown;
      });
      assert.equal(seenEvents.length, 1);
      assert.equal(seenEvents[0]!.sessionId, app.sessionId);
      assert.match(terminal.captureCharFrame(), /login\.example\.test\/authorize/);
      assert.doesNotMatch(terminal.captureCharFrame(), /test-private-poll-token/);
      // Waiting for the actual command completion also waits for credential and Registry barriers.
      await action(async () => {
        authorize();
        await loginCompletion;
      });
      await action(() => terminal.mockInput.typeText("/model"));
      assert.match(terminal.captureCharFrame(), /GLM-/);
      assert.doesNotMatch(terminal.captureCharFrame(), /No available models/);
    } finally {
      await action(async () => {
        authorize();
        await loginCompletion;
      });
      await React.act(() => root.unmount());
      terminal.renderer.destroy();
      if (previous === undefined) delete environment.IS_REACT_ACT_ENVIRONMENT;
      else environment.IS_REACT_ACT_ENVIRONMENT = previous;
    }
  },
);

test("standalone login accepts provider selection and keeps authorization URL out of JSON stdout", async () => {
  let stdout = "";
  let stderr = "";
  let selected = "";
  const deps = {
    env: {},
    cwd: () => process.cwd(),
    loadDotenv: () => ({ keys: [], loaded: false, path: "" }),
    loginZCodeCli: async (options: LoginZCodeCliOptions) => {
      selected = options.providerId!;
      assert.equal(options.noBrowser, true);
      await options.onAuthorizeUrl?.({
        authorize_url: authorizeUrl,
        expires_at: 12345,
        flow_id: "flow",
        poll_interval_sec: 1,
      });
      return {
        providerId: "bigmodel",
        user: { user_id: "test-account" },
        model: "provider/model",
        configPath: "test-config",
        credentialsPath: "test-credentials",
      };
    },
  } as unknown as RunDependencies;
  const context = {
    stdout: {
      write: (text: string) => {
        stdout += text;
      },
    },
    stderr: {
      write: (text: string) => {
        stderr += text;
      },
    },
  } as unknown as Parameters<typeof runLoginCommand>[0];
  const options = { json: true } as Parameters<typeof runLoginCommand>[1];
  assert.equal(await runLoginCommand(context, options, deps, true, ["bigmodel"]), 0);
  assert.equal(selected, "bigmodel");
  assert.equal(JSON.parse(stdout).provider, "bigmodel");
  assert.match(stderr, /login\.example\.test/);
  assert.doesNotMatch(stdout, /authorize/);
});
