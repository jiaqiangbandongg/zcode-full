import type { ProviderFamilyDomain, ProjectAccessTokenMaterial } from "@zcode/shared";
import { createServiceLogger } from "../logger/serviceLogger.js";

const log = createServiceLogger("account-project-token");
interface AccountProviderCredentialServiceOptions {
  readonly loadOAuthAccessToken: (family: ProviderFamilyDomain) => Promise<string | null>;
  readonly resolveProviderMaterial: (
    family: ProviderFamilyDomain,
    accessToken: string,
    accountIdentity: string,
    rejectedProjectTokenFingerprint?: string,
  ) => Promise<ProjectAccessTokenMaterial | null>;
}
interface LoadCodingPlanApiKeyInput {
  readonly providerId: string;
  readonly family: ProviderFamilyDomain;
  readonly accountIdentity: string;
  readonly forceRefresh?: boolean;
  readonly rejectedProjectTokenFingerprint?: string;
}
export interface AccountProviderCredentialService {
  loadCodingPlanApiKey(input: LoadCodingPlanApiKeyInput): Promise<string | null>;
  loadCodingPlanMaterial(
    input: LoadCodingPlanApiKeyInput,
  ): Promise<ProjectAccessTokenMaterial | null>;
}

/** 旧方法名兼容私有调用契约；返回值现在是请求期 Token，绝不读写长期 Key 缓存。 */
export function createAccountProviderCredentialService(
  options: AccountProviderCredentialServiceOptions,
): AccountProviderCredentialService {
  const pending = new Map<string, Promise<ProjectAccessTokenMaterial | null>>();
  return {
    async loadCodingPlanApiKey(input) {
      return (await this.loadCodingPlanMaterial(input))?.token ?? null;
    },
    async loadCodingPlanMaterial(input) {
      const loginToken = (await options.loadOAuthAccessToken(input.family))?.trim();
      if (!loginToken) return null;
      // Map 仅存进程内并发状态；登录态变化不能加入旧账号请求。
      const key = JSON.stringify([
        input.family,
        input.accountIdentity,
        loginToken,
        input.rejectedProjectTokenFingerprint,
      ]);
      const existing = pending.get(key);
      if (existing) return existing;
      const operation = (async () => {
        const token = await options.resolveProviderMaterial(
          input.family,
          loginToken,
          input.accountIdentity,
          input.rejectedProjectTokenFingerprint,
        );
        if ((await options.loadOAuthAccessToken(input.family))?.trim() !== loginToken) {
          log.warn(undefined, "项目 Token 签发期间登录态变化，丢弃结果", {
            family: input.family,
          });
          throw new Error("project_token_scope_invalidated");
        }
        return token ?? null;
      })();
      pending.set(key, operation);
      try {
        return await operation;
      } finally {
        if (pending.get(key) === operation) pending.delete(key);
      }
    },
  };
}
