import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { HttpClientPort, HttpClientRequest, HttpClientResponse } from "@zcode/contracts";
import {
  SHARED_ZCODE_CREDENTIAL_KEYS,
  createSharedZCodeCredentialStore,
} from "@zcode/adapters/auth";
import { BUILTIN_MODEL_PROVIDER_IDS } from "@zcode/shared";
import {
  standaloneAccountIdentityCredentialKey,
  standaloneAccountAuthSourceCredentialKey,
  standaloneAccountProviderCredentialKey,
} from "../src/app/standalone-account-provider-runtime.js";
import {
  configureCodingPlanApiKey,
  hasConfiguredStandaloneCodingPlan,
  loginZCodeCli,
  logoutZCodeCli,
} from "../src/auth-login.js";

const TEST_ENV = {
  ZCODE_CREDENTIAL_SECRET: "bootstrap-test-secret",
  ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: fileURLToPath(
    new URL("../../../../../config/provider/zcode-builtin.json", import.meta.url),
  ),
};

describe("ZCode CLI login", () => {
  it("没有任何 Standalone 账号凭据时不会误报已配置 Coding Plan", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-no-login-"));
    const credentialStore = createSharedZCodeCredentialStore({
      baseDir: dir,
      env: TEST_ENV,
    });
    try {
      await expect(
        hasConfiguredStandaloneCodingPlan({ credentialStore, env: TEST_ENV }),
      ).resolves.toBe(false);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("uses the production ZCode endpoint by default for OAuth init", async () => {
    const httpClient = new FakeHttpClient([
      jsonResponse({
        code: 0,
        msg: "",
        data: {
          flow_id: "flow-failed",
          poll_token: "poll-token",
          authorize_url: "https://chat.z.ai/oauth/authorize?state=failed",
          expires_at: 9999999999,
          poll_interval_sec: 2,
        },
      }),
      jsonResponse({
        code: 0,
        msg: "",
        data: {
          status: "failed",
        },
      }),
    ]);

    await expect(
      loginZCodeCli({
        env: TEST_ENV,
        httpClient,
        noBrowser: true,
        now: () => 1_000,
        pollToken: "poll-token",
        sleep: async () => undefined,
      }),
    ).rejects.toMatchObject({
      code: "auth_failed",
    });

    expect(httpClient.requests[0]?.url).toBe("https://zcode.z.ai/api/v1/oauth/cli/init");
  });

  it("polls OAuth, stores account credentials, and updates the configured default", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-login-"));
    const credentialsBaseDir = join(dir, "home");
    const personalProviderConfigPath = join(dir, "provider_config.json");
    const credentialStore = createSharedZCodeCredentialStore({
      baseDir: credentialsBaseDir,
      env: TEST_ENV,
    });
    const httpClient = new FakeHttpClient([
      jsonResponse({
        code: 0,
        msg: "",
        data: {
          flow_id: "flow-1",
          poll_token: "poll-token",
          authorize_url: "https://chat.z.ai/oauth/authorize?state=state",
          expires_at: 9999999999,
          poll_interval_sec: 2,
        },
      }),
      jsonResponse({
        code: 0,
        msg: "",
        data: {
          status: "pending",
        },
      }),
      jsonResponse({
        code: 0,
        msg: "",
        data: {
          status: "ready",
          token: "jwt-token",
          user: {
            user_id: "u_1",
            email: "alice@example.com",
            name: "Alice",
          },
          zai: {
            access_token: "zai-access-token",
          },
        },
      }),
      jsonResponse({
        code: 0,
        data: {
          access_token: "zai-biz-token",
        },
      }),
      jsonResponse({
        code: 200,
        data: {
          organizations: [
            {
              organizationId: "org-1",
              organizationName: "默认机构",
              projects: [
                {
                  projectId: "project-1",
                  projectName: "默认项目",
                },
              ],
            },
          ],
        },
      }),
      jsonResponse({
        code: 200,
        data: [],
      }),
      jsonResponse({
        code: 200,
        data: {
          apiKey: "zai-api-key",
          name: "zcode-api-key",
        },
      }),
      jsonResponse({
        code: 200,
        data: {
          accessToken: "project-token",
          tokenType: "Bearer",
          expiresIn: 600,
          expiresAt: Math.floor(Date.now() / 1000) + 600,
        },
      }),
    ]);
    const statuses: string[] = [];
    let authorizeUrl = "";

    try {
      const result = await loginZCodeCli({
        credentialStore,
        env: TEST_ENV,
        httpClient,
        noBrowser: true,
        now: () => 1_000,
        onAuthorizeUrl: (data) => {
          authorizeUrl = data.authorize_url;
        },
        onPollStatus: (data) => {
          statuses.push(data.status);
        },
        pollToken: "poll-token",
        sleep: async () => undefined,
        personalProviderConfigPath,
      });

      const modelSelectionConfig = JSON.parse(await readFile(personalProviderConfigPath, "utf-8"));
      const accountProviderCredentialKey = standaloneAccountProviderCredentialKey({
        providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
        accountIdentity: "u_1",
      });
      expect(authorizeUrl).toBe("https://chat.z.ai/oauth/authorize?state=state");
      expect(statuses).toEqual(["pending", "ready"]);
      expect(result).toMatchObject({
        configPath: personalProviderConfigPath,
        credentialsPath: credentialStore.filePath,
        model: `${BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan}/GLM-5.3`,
        providerId: "zai",
        user: {
          user_id: "u_1",
          email: "alice@example.com",
          name: "Alice",
        },
      });
      expect(await credentialStore.load(SHARED_ZCODE_CREDENTIAL_KEYS.zaiAccessToken)).toBe(
        "zai-access-token",
      );
      expect(await credentialStore.load(SHARED_ZCODE_CREDENTIAL_KEYS.zcodeJwtToken)).toBe(
        "jwt-token",
      );
      expect(
        await credentialStore.load(
          standaloneAccountIdentityCredentialKey(
            BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
          ),
        ),
      ).toBe("u_1");
      expect(await credentialStore.load(accountProviderCredentialKey)).toBeNull();
      expect(modelSelectionConfig).toMatchObject({
        schemaVersion: 1,
        config: {
          defaultModelSelection: {
            providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
            modelId: "GLM-5.3",
          },
        },
      });
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("clears shared ZAI credentials and standalone account access on logout", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-logout-"));
    const credentialStore = createSharedZCodeCredentialStore({
      baseDir: dir,
      env: TEST_ENV,
    });

    try {
      await credentialStore.saveZaiLoginCredentials({
        accessToken: "zai-access-token",
        jwtToken: "jwt-token",
        user: {
          user_id: "u_1",
        },
      });
      const accountProviderCredentialKey = standaloneAccountProviderCredentialKey({
        providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
        accountIdentity: "u_1",
      });
      await credentialStore.saveMany({
        [standaloneAccountIdentityCredentialKey(
          BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
        )]: "u_1",
        [standaloneAccountAuthSourceCredentialKey(
          BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
        )]: "manual",
        [accountProviderCredentialKey]: "coding-plan-key",
      });

      const result = await logoutZCodeCli({ credentialStore, env: TEST_ENV });

      expect(result.credentialsPath).toBe(credentialStore.filePath);
      expect(await credentialStore.load(SHARED_ZCODE_CREDENTIAL_KEYS.zaiAccessToken)).toBeNull();
      expect(await credentialStore.load(SHARED_ZCODE_CREDENTIAL_KEYS.activeProvider)).toBeNull();
      expect(
        await credentialStore.load(
          standaloneAccountIdentityCredentialKey(
            BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
          ),
        ),
      ).toBeNull();
      expect(await credentialStore.load(accountProviderCredentialKey)).toBeNull();
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it.each(["oauth", undefined])("退出不解密来源为 %s 的历史旧 Key", async (source) => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-logout-legacy-"));
    const credentialStore = createSharedZCodeCredentialStore({ baseDir: dir, env: TEST_ENV });
    const providerId = BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan;
    const legacyKey = standaloneAccountProviderCredentialKey({
      providerId,
      accountIdentity: "user",
    });
    try {
      await credentialStore.saveMany({
        [SHARED_ZCODE_CREDENTIAL_KEYS.zaiAccessToken]: "valid-oauth",
        [standaloneAccountIdentityCredentialKey(providerId)]: "user",
        ...(source ? { [standaloneAccountAuthSourceCredentialKey(providerId)]: source } : {}),
      });
      const raw = JSON.parse(await readFile(credentialStore.filePath, "utf8"));
      raw[legacyKey] = "enc:v1:broken-legacy-key";
      await writeFile(credentialStore.filePath, JSON.stringify(raw));
      await expect(logoutZCodeCli({ credentialStore, env: TEST_ENV })).resolves.toMatchObject({
        credentialsPath: credentialStore.filePath,
      });
      expect(await credentialStore.load(SHARED_ZCODE_CREDENTIAL_KEYS.zaiAccessToken)).toBeNull();
      expect(
        await credentialStore.load(standaloneAccountIdentityCredentialKey(providerId)),
      ).toBeNull();
      expect(JSON.parse(await readFile(credentialStore.filePath, "utf8"))[legacyKey]).toBe(
        raw[legacyKey],
      );
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("manual Coding Plan API Key uses the same Account Access and Selection facts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-api-key-login-"));
    const credentialStore = createSharedZCodeCredentialStore({
      baseDir: join(dir, "home"),
      env: TEST_ENV,
    });
    const personalProviderConfigPath = join(dir, "provider_config.json");
    const zcodeBuiltinProviderConfigPath = join(dir, "zcode-builtin.json");
    const configuredProviderId = "configured-bigmodel-individual";
    await writeFile(
      zcodeBuiltinProviderConfigPath,
      JSON.stringify({
        schemaVersion: 1,
        revision: 1,
        config: {
          providerConfigRules: {
            templateRules: [],
            providerRules: [
              {
                providerId: configuredProviderId,
                config: {
                  group: "bigmodel-family",
                  builtinModelIds: ["model-from-config"],
                  access: {
                    type: "zhipu-account",
                    accountType: "bigmodel",
                    mode: "individual-coding-plan",
                  },
                },
              },
            ],
          },
          modelConfigRules: {
            modelRules: [],
            modelApiRules: [],
            providerSiteRules: [],
            templateModelRules: [],
            builtinProviderModelRules: [],
          },
        },
      }),
    );

    try {
      const result = await configureCodingPlanApiKey({
        apiKey: "manual-key",
        credentialStore,
        env: {
          ...TEST_ENV,
          ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: zcodeBuiltinProviderConfigPath,
        },
        personalProviderConfigPath,
        providerId: "bigmodel",
      });

      expect(result).toEqual({
        configPath: personalProviderConfigPath,
        model: `${configuredProviderId}/model-from-config`,
        providerId: "bigmodel",
      });
      await expect(
        hasConfiguredStandaloneCodingPlan({
          credentialStore,
          env: {
            ...TEST_ENV,
            ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: zcodeBuiltinProviderConfigPath,
          },
        }),
      ).resolves.toBe(true);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("reports failed and expired OAuth flows as retryable login errors", async () => {
    const failedClient = new FakeHttpClient([
      jsonResponse({
        code: 0,
        msg: "",
        data: {
          flow_id: "flow-failed",
          poll_token: "poll-token",
          authorize_url: "https://chat.z.ai/oauth/authorize?state=failed",
          expires_at: 9999999999,
          poll_interval_sec: 2,
        },
      }),
      jsonResponse({
        code: 0,
        msg: "",
        data: {
          status: "failed",
        },
      }),
    ]);

    await expect(
      loginZCodeCli({
        env: TEST_ENV,
        httpClient: failedClient,
        noBrowser: true,
        now: () => 1_000,
        pollToken: "poll-token",
        sleep: async () => undefined,
      }),
    ).rejects.toMatchObject({
      code: "auth_failed",
    });

    const expiredClient = new FakeHttpClient([
      jsonResponse({
        code: 0,
        msg: "",
        data: {
          flow_id: "flow-expired",
          poll_token: "poll-token",
          authorize_url: "https://chat.z.ai/oauth/authorize?state=expired",
          expires_at: 1,
          poll_interval_sec: 2,
        },
      }),
    ]);

    await expect(
      loginZCodeCli({
        env: TEST_ENV,
        httpClient: expiredClient,
        noBrowser: true,
        now: () => 2_000,
        pollToken: "poll-token",
        sleep: async () => undefined,
      }),
    ).rejects.toMatchObject({
      code: "auth_timeout",
    });
  });

  it("aborts a ZAI OAuth login while waiting for authorization", async () => {
    const abortController = new AbortController();
    let sleepStarted: (() => void) | undefined;
    const sleepPromise = new Promise<void>((resolve) => {
      sleepStarted = resolve;
    });
    const httpClient = new FakeHttpClient([
      jsonResponse({
        code: 0,
        msg: "",
        data: {
          flow_id: "flow-abort",
          poll_token: "poll-token",
          authorize_url: "https://chat.z.ai/oauth/authorize?state=abort",
          expires_at: 9999999999,
          poll_interval_sec: 2,
        },
      }),
      jsonResponse({
        code: 0,
        msg: "",
        data: {
          status: "pending",
        },
      }),
    ]);

    const loginPromise = loginZCodeCli({
      abortSignal: abortController.signal,
      env: TEST_ENV,
      httpClient,
      noBrowser: true,
      now: () => 1_000,
      pollToken: "poll-token",
      sleep: async () => {
        sleepStarted?.();
        await new Promise<void>(() => undefined);
      },
    });

    await sleepPromise;
    abortController.abort(new Error("login cancelled"));

    await expect(loginPromise).rejects.toThrow("login cancelled");
    expect(httpClient.requests).toHaveLength(2);
  });
});

class FakeHttpClient implements HttpClientPort {
  readonly requests: HttpClientRequest[] = [];

  constructor(private readonly responses: HttpClientResponse[]) {}

  async request(request: HttpClientRequest): Promise<HttpClientResponse> {
    this.requests.push(request);
    const response = this.responses.shift();
    if (!response) {
      throw new Error("No fake response configured");
    }
    return response;
  }
}

function jsonResponse(body: unknown): HttpClientResponse {
  const encoded = new TextEncoder().encode(JSON.stringify(body));
  return {
    body: encoded,
    bytes: encoded.byteLength,
    durationMs: 1,
    headers: {
      "content-type": "application/json",
    },
    status: 200,
    statusText: "OK",
    url: "https://zcode.example/api/v1",
  };
}
