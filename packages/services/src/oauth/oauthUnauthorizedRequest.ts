import {
  BIGMODEL_PROVIDER_ID,
  ZAI_PROVIDER_ID,
  buildBigModelApiUrl,
  buildRuntimeZaiBusinessUrl,
} from "@zcode/shared";
import type { ICredentialService } from "#src/credential/credential.js";
import { resolveBigModelUserinfoUrl } from "#src/oauth/providers/bigmodelProviderConfig.js";
import { resolveZaiUserinfoUrl } from "#src/oauth/providers/zaiProviderConfig.js";

function tryResolveHttpUrl(resolve: () => string | URL): URL | null {
  try {
    const url = new URL(resolve());
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

const OAUTH_BUSINESS_PATHS = [
  "/api/biz/customer/getCustomerInfo",
  "/api/biz/subscription/enterprise/v2/pricing",
  "/api/biz/team/subscribe/product/querySubscribeDetail",
] as const;

async function isCurrentBusinessOAuthCredentialRequest(options: {
  input: string | URL;
  headers: Headers;
  credentialService: Pick<ICredentialService, "load">;
  env?: NodeJS.ProcessEnv;
}): Promise<boolean> {
  const authorization = options.headers.get("authorization")?.trim() ?? "";
  if (!authorization) return false;

  const provider = await options.credentialService.load("oauth:active_provider");
  if (!(await isOAuthBusinessRequest({ ...options, provider }))) return false;

  const accessToken = (
    await options.credentialService.load(`oauth:${provider}:access_token`)
  )?.trim();
  if (!accessToken || (authorization !== accessToken && authorization !== `Bearer ${accessToken}`))
    return false;
  // 读取磁盘期间可能切换平台，不能拿上一平台残留 token 的 401 清理当前登录。
  return (await options.credentialService.load("oauth:active_provider")) === provider;
}

export async function isOAuthBusinessRequest(options: {
  input: string | URL;
  credentialService: Pick<ICredentialService, "load">;
  env?: NodeJS.ProcessEnv;
  provider?: string | null;
}): Promise<boolean> {
  const provider =
    options.provider ?? (await options.credentialService.load("oauth:active_provider"));
  if (provider !== BIGMODEL_PROVIDER_ID && provider !== ZAI_PROVIDER_ID) return false;
  const env = options.env ?? process.env;
  const requestUrl = tryResolveHttpUrl(() => options.input);
  if (!requestUrl) return false;
  const urls =
    provider === BIGMODEL_PROVIDER_ID
      ? [
          ...OAUTH_BUSINESS_PATHS.map((path) => () => buildBigModelApiUrl(env, path)),
          () => resolveBigModelUserinfoUrl(env),
        ]
      : [
          ...OAUTH_BUSINESS_PATHS.map((path) => () => buildRuntimeZaiBusinessUrl(env, path)),
          () => resolveZaiUserinfoUrl(env),
        ];
  return urls.some((resolve) => {
    const expected = tryResolveHttpUrl(resolve);
    return (
      expected !== null &&
      requestUrl.origin === expected.origin &&
      requestUrl.pathname === expected.pathname
    );
  });
}

export async function isCurrentOAuthBusinessCredentialRequest(options: {
  input: string | URL;
  headers: Headers;
  credentialService: Pick<ICredentialService, "load">;
  env?: NodeJS.ProcessEnv;
}): Promise<boolean> {
  return isCurrentBusinessOAuthCredentialRequest(options);
}

// 这里只判定候选请求；实际退出须由 OAuthService 在会话变更队列内复核，不能依赖异步旧快照。
export async function isCurrentOAuthCredentialRequest(options: {
  input: string | URL;
  headers: Headers;
  credentialService: Pick<ICredentialService, "load">;
  env?: NodeJS.ProcessEnv;
}): Promise<boolean> {
  const authorization = options.headers.get("authorization")?.trim() ?? "";
  if (!authorization) return false;
  const currentJwt = (await options.credentialService.load("zcodejwttoken"))?.trim() ?? "";
  if (currentJwt && authorization === `Bearer ${currentJwt}`) return true;
  return isCurrentBusinessOAuthCredentialRequest(options);
}
