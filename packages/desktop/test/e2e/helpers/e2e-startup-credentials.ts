import { isRequestSecuritySpec } from "./request-security-edition/index.js";
export interface E2EStartupCredentialSeedOptions {
  specs?: string[];
  legacyAuthToken: string;
  restoredOAuthCredentials: Record<string, string>;
}

const PERSONAL_PROVIDER_ONLY_SPEC_NAMES = new Set([
  "conversation-session-composer-draft-switching.test.ts",
  "conversation-session-draft-model-switch-first-send.test.ts",
  "conversation-session-unbound-resume.test.ts",
  "conversation-session-v4-composer-toolbar.test.ts",
  // SSH 配置同步用例只需 Personal 配置；假 OAuth 的 401 会在连接前遮住向导入口。
  "conversation-session-ssh-provisioning-failure.test.ts",
]);

// 这些 fork/goal/tool 场景也只使用本地回放 Provider；假 OAuth 会触发真实控制面
// 鉴权失败并遮挡被测交互，因此与 Personal-only 场景一样保持无账号启动。
const ACCOUNTLESS_FORK_SPEC_NAMES = new Set([
  "conversation-session-automation-cron-create.test.ts",
  "conversation-session-fork-merged-assistant.test.ts",
  "conversation-session-goal-run-cases.test.ts",
  // 引导布局回归只依赖本地回放 Provider；假账号会弹出登录过期提示，遮住职业引导。
  "conversation-session-running-guide-steer.test.ts",
  "conversation-session-tool-cross-product.test.ts",
  "conversation-session-v4-fork-edit-branch.test.ts",
]);

export function createE2EStartupCredentialSeed(
  options: E2EStartupCredentialSeedOptions,
): Record<string, string> {
  if (
    options.specs?.some((spec) => {
      const fileName = spec.replaceAll("\\", "/").split("/").at(-1);
      return (
        fileName !== undefined &&
        (PERSONAL_PROVIDER_ONLY_SPEC_NAMES.has(fileName) ||
          ACCOUNTLESS_FORK_SPEC_NAMES.has(fileName))
      );
    })
  ) {
    // Bug 原因：这些 case 只验证 Personal Provider 的会话/Composer 行为；默认假 JWT
    // 会访问真实账号控制面并触发 401 弹窗，遮挡真正待测交互。它们从无账号态进入，
    // 再通过正式 API Key/Personal Provider UI 建立测试前置。
    return {};
  }
  const restoredOAuthCredentials = { ...options.restoredOAuthCredentials };
  const requiresZCodeJwt = options.specs?.some((spec) => {
    const fileName = spec.replaceAll("\\", "/").split("/").at(-1);
    return (
      // 营销投放 spec 按主题拆成 marketing-touch-delivery*.test.ts，领取用例都需要本地 JWT。
      fileName?.startsWith("marketing-touch-delivery") ||
      fileName === "marketing-touch-entitlement.test.ts" ||
      // Rewards 专项走本地控制面，需要同时验证 OAuth 与 JWT 注入。
      fileName === "marketing-touch-rewards.test.ts" ||
      fileName === "jwt-401-auto-logout.test.ts" ||
      isRequestSecuritySpec(fileName) ||
      fileName === "coding-plan-upgrade-webview-refresh-provider.test.ts" ||
      fileName === "start-plan-manual-claim-experience.test.ts" ||
      fileName === "provider-family-responsive.test.ts"
    );
  });
  // 合并时遗漏了普通 E2E 的 JWT 隔离：假的 JWT 会访问真实套餐接口并弹出登录失效提示。
  // 保留 OAuth 展示态；只有认证专项、本地 mock 的领取与响应式用例需要 JWT。
  if (!requiresZCodeJwt) delete restoredOAuthCredentials.zcodejwttoken;
  return {
    auth_token: options.legacyAuthToken,
    ...restoredOAuthCredentials,
  };
}
