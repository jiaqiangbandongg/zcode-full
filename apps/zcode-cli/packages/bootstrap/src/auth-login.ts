export { hasConfiguredStandaloneCodingPlan, logoutZCodeCli } from "./auth-login-persistence.js";
import {
  persistStandaloneCodingPlanConnection,
  type StandaloneCodingPlanPersistenceResult,
} from "./auth-login-persistence.js";
export { ZCodeCliLoginError } from "./auth-login-contract.js";
export type {
  CodingPlanProviderId,
  LoginZCodeCliOptions,
  LoginZCodeCliResult,
  LoginBigmodelCodingPlanOptions,
  LoginBigmodelCodingPlanResult,
  ConfigureCodingPlanApiKeyOptions,
  ConfigureCodingPlanApiKeyResult,
  LogoutZCodeCliOptions,
  LogoutZCodeCliResult,
} from "./auth-login-contract.js";
import {
  ZCodeCliLoginError,
  type CodingPlanProviderId,
  type LoginZCodeCliOptions,
  type LoginZCodeCliResult,
  type LoginBigmodelCodingPlanOptions,
  type LoginBigmodelCodingPlanResult,
  type ConfigureCodingPlanApiKeyOptions,
  type ConfigureCodingPlanApiKeyResult,
} from "./auth-login-contract.js";
import {
  createCodingPlanApiKeyResolver,
  createSharedZCodeCredentialStore,
  createCliOAuthClient,
  createCliOAuthPollToken,
  openUrlInBrowser,
  SHARED_ZCODE_CREDENTIAL_KEYS,
  type CliOAuthClient,
} from "@zcode/adapters";
import { createConfig } from "@zcode/adapters/config";
import { createNodeHttpClientAdapter } from "@zcode/adapters/http";
import type { EnvRecord } from "@zcode/adapters/model";
import { buildZCodeEndpointUrls, resolveRuntimeZCodeEndpointOrigin } from "@zcode/shared";
import { setTimeout as delay } from "node:timers/promises";
import { createStandaloneAccountIdentityFromSecret } from "./app/standalone-account-provider-runtime.js";
import { throwIfAborted, waitWithAbort } from "./auth-login-abort.js";
import { pollUntilReady } from "./auth-login-polling.js";

const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60 * 1_000;

/**
 * Z.ai 与 BigModel 共用服务端轮询登录：init 拿授权地址，浏览器授权后轮询到 ready，
 * 再解析项目访问材料并写入凭据与默认模型。OAuth 登录不落盘派生 API Key，
 * 运行时按 `authSource: "oauth"` 用访问令牌换取请求凭据。
 */
export async function loginZCodeCli(
  options: LoginZCodeCliOptions = {},
): Promise<LoginZCodeCliResult> {
  const env = options.env ?? process.env;
  const providerId = options.providerId ?? "zai";
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;
  const deadlineMs = now() + timeoutMs;
  const timeoutController = new AbortController();
  const signal = options.abortSignal
    ? AbortSignal.any([options.abortSignal, timeoutController.signal])
    : timeoutController.signal;
  const timeoutError = () =>
    new ZCodeCliLoginError("auth_timeout", "Authorization timed out. Please retry login.");
  let timer = setTimeout(() => timeoutController.abort(timeoutError()), timeoutMs);
  try {
    throwIfAborted(signal);
    const pollToken = options.pollToken ?? createCliOAuthPollToken();
    const credentialStore = options.credentialStore ?? createSharedZCodeCredentialStore({ env });
    const oauthClient = createOAuthClient(options, env);
    const initData = await waitWithAbort(oauthClient.init({ pollToken }, { signal }), signal);
    const remainingMs = Math.min(deadlineMs, initData.expires_at * 1_000) - now();
    if (remainingMs <= 0) throw timeoutError();
    clearTimeout(timer);
    timer = setTimeout(() => timeoutController.abort(timeoutError()), remainingMs);
    await options.onAuthorizeUrl?.(initData);
    throwIfAborted(signal);
    const browser = options.noBrowser
      ? undefined
      : await waitWithAbort(
          (options.openBrowser ?? openUrlInBrowser)(initData.authorize_url),
          signal,
        );
    if (browser) await options.onBrowserOpen?.(browser);
    const readyData = await pollUntilReady({
      abortSignal: signal,
      initData,
      now,
      oauthClient,
      onPollStatus: options.onPollStatus,
      pollToken,
      sleep: options.sleep ?? ((ms) => delay(ms, undefined, { signal })),
      timeoutMs: Math.max(0, deadlineMs - now()),
      createError: (code) =>
        code === "auth_timeout"
          ? timeoutError()
          : new ZCodeCliLoginError(code, "Authorization failed. Please retry login."),
    });
    const material = await waitWithAbort(
      resolveCodingPlanMaterial({
        accessToken: readyData.accessToken,
        env,
        httpClient: options.httpClient,
        family: providerId,
        resolver: options.apiKeyResolver,
        signal,
      }),
      signal,
    );
    // 已取消或已超时的登录不能把迟到的 ready 响应写入凭据。
    throwIfAborted(signal);
    // Z.ai 以账号用户 ID 作为连接身份；BigModel 的项目令牌按组织与项目签发，
    // 连接身份沿用组织与项目的稳定摘要，与运行时的令牌缓存范围一致。
    const accountIdentity =
      providerId === "zai"
        ? readyData.user.user_id
        : createStandaloneAccountIdentityFromSecret(
            JSON.stringify([material.organizationId, material.projectId]),
          );
    try {
      if (providerId === "zai") {
        await credentialStore.saveZaiLoginCredentials({
          accessToken: readyData.accessToken,
          jwtToken: readyData.token,
          user: readyData.user,
        });
      } else {
        const displayName = readyData.user.name || readyData.user.email || readyData.user.user_id;
        await credentialStore.saveMany({
          [SHARED_ZCODE_CREDENTIAL_KEYS.activeProvider]: providerId,
          [SHARED_ZCODE_CREDENTIAL_KEYS.zcodeJwtToken]: readyData.token,
          [SHARED_ZCODE_CREDENTIAL_KEYS.bigmodelAccessToken]: readyData.accessToken,
          ...(readyData.refreshToken
            ? { [SHARED_ZCODE_CREDENTIAL_KEYS.bigmodelRefreshToken]: readyData.refreshToken }
            : {}),
          [SHARED_ZCODE_CREDENTIAL_KEYS.bigmodelUserInfo]: JSON.stringify({
            id: accountIdentity,
            username: displayName,
            displayName,
            rawProfile: readyData.user,
          }),
        });
      }
    } catch (error) {
      throw new ZCodeCliLoginError(
        "credential_write_failed",
        "Login succeeded but writing credentials failed.",
        { cause: error },
      );
    }
    throwIfAborted(signal);
    let configPatch: StandaloneCodingPlanPersistenceResult;
    try {
      configPatch = await persistStandaloneCodingPlanConnection({
        accountIdentity,
        authSource: "oauth",
        credentialStore,
        env,
        personalProviderConfigPath: options.personalProviderConfigPath,
        providerId,
      });
    } catch (error) {
      throw new ZCodeCliLoginError(
        "config_update_failed",
        "Login succeeded but updating ZCode config failed.",
        { cause: error },
      );
    }
    return {
      ...(browser ? { browser } : {}),
      configPath: configPatch.path,
      credentialsPath: credentialStore.filePath,
      model: configPatch.mainModel,
      providerId,
      user: readyData.user,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function loginBigmodelCodingPlan(
  options: LoginBigmodelCodingPlanOptions = {},
): Promise<LoginBigmodelCodingPlanResult> {
  return {
    ...(await loginZCodeCli({ ...options, providerId: "bigmodel" })),
    providerId: "bigmodel",
  };
}

export async function configureCodingPlanApiKey(
  options: ConfigureCodingPlanApiKeyOptions,
): Promise<ConfigureCodingPlanApiKeyResult> {
  const apiKey = options.apiKey.trim();
  if (!apiKey) {
    throw new ZCodeCliLoginError("config_update_failed", "API key must not be empty.");
  }
  const credentialStore =
    options.credentialStore ?? createSharedZCodeCredentialStore({ env: options.env });
  const configPatch = await persistStandaloneCodingPlanConnection({
    accountIdentity: createStandaloneAccountIdentityFromSecret(apiKey),
    apiKey,
    credentialStore,
    env: options.env ?? process.env,
    personalProviderConfigPath: options.personalProviderConfigPath,
    providerId: options.providerId,
  });
  return {
    configPath: configPatch.path,
    model: configPatch.mainModel,
    providerId: options.providerId,
  };
}

function createOAuthClient(options: LoginZCodeCliOptions, env: EnvRecord): CliOAuthClient {
  return createCliOAuthClient({
    baseUrl:
      options.baseUrl ?? buildZCodeEndpointUrls(resolveCliZCodeEndpointOrigin(env)).apiBaseUrl,
    providerId: options.providerId ?? "zai",
    httpClient: options.httpClient ?? createDefaultHttpClient(env),
  });
}

function resolveCliZCodeEndpointOrigin(env: EnvRecord): string {
  return resolveRuntimeZCodeEndpointOrigin(env);
}

function createDefaultHttpClient(env: EnvRecord) {
  const config = createConfig({ env });
  return createNodeHttpClientAdapter({
    env,
    proxyUrl: config.config.network.httpProxy,
    noProxy: config.config.network.noProxy,
    caCertFile: config.config.network.caCertFile,
    timeoutMs: config.config.network.timeout,
  });
}

async function resolveCodingPlanMaterial(input: {
  accessToken: string;
  env: EnvRecord;
  httpClient?: Parameters<typeof createCodingPlanApiKeyResolver>[0]["httpClient"];
  family: CodingPlanProviderId;
  signal?: AbortSignal;
  resolver?: ReturnType<typeof createCodingPlanApiKeyResolver>;
}) {
  const resolver =
    input.resolver ??
    createCodingPlanApiKeyResolver({
      httpClient: input.httpClient ?? createDefaultHttpClient(input.env),
    });
  return resolver.resolveMaterial(
    {
      accessToken: input.accessToken,
      family: input.family,
    },
    { signal: input.signal },
  );
}
