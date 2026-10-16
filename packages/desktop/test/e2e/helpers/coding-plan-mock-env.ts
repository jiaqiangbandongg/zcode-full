export const CODING_PLAN_TEAM_MOCK_BASE_URL_ENV = "ZCODE_CODING_PLAN_TEAM_MOCK_BASE_URL";
export const CODING_PLAN_UPGRADE_MOCK_BASE_URL_ENV = "ZCODE_CODING_PLAN_UPGRADE_MOCK_BASE_URL";

type MutableEnvironment = Record<string, string | undefined>;

const CODING_PLAN_COMMON_ENV_KEYS = [
  "ZCODE_BASE_URL",
  "ZCODE_ENDPOINT_ORIGIN",
  "ZCODE_TEST_BASE_URL",
  "BIGMODEL_API_BASE_URL",
  "ZCODE_E2E_CODING_PLAN_MOCK_URL",
] as const;

const DEFAULT_FULL_E2E_SPEC_GLOB = "./test/e2e/**/*.test.ts";
const CODING_PLAN_TEAM_SPEC_MARKERS = [
  "conversation-session-start-plan-independent.test.ts",
  // 创建埋点回归复用本地账号控制面，避免初始化/发送访问真实套餐与登录服务。
  "conversation-session-create-telemetry.test.ts",
  "conversation-session-automation-run-title-stable.test.ts",
  "coding-plan-team-usage.test.ts",
  "coding-plan-entitlement-presentation.test.ts",
  "provider-family-responsive.test.ts",
  // Bugfix：登录后刷新子代理 catalog 的 case 与套餐用量 case 共用 team mock。
  // 抽取 spec 判定时必须保留该入口，否则单跑时 worker 会在业务断言前缺少 mock。
  "subagent-coding-plan-login-catalog-stale.test.ts",
  "conversation-session-model-provider-restart-recovery.test.ts",
  "conversation-session-model-provider-settings-transition.test.ts",
  "conversation-session-model-provider-effective-selection.test.ts",
  "conversation-session-worker-effective-selection.test.ts",
  "conversation-session-model-provider-turbo-recovery.test.ts",
  "conversation-session-model-provider-turbo-switch.test.ts",
  // Highspeed 抽卡 case 要按 Coding Plan 权益判定资格，缺 team mock 时抽卡入口不曝光。
  "conversation-session-highspeed-card.test.ts",
  "conversation-session-highspeed-card-draw-timeout.test.ts",
  "conversation-session-highspeed-card-draw-miss.test.ts",
  "conversation-session-model-provider-plan-surface.test.ts",
  // Bug 原因：连续切模回放也播种了模拟登录态；未隔离控制面时，线上 401
  // 会触发登录过期弹窗，遮住第二轮的模型菜单，导致与切模无关的失败。
  "conversation-session-active-model-context.test.ts",
  "conversation-session-off-peak-team-plan.test.ts",
  // Bug 原因：只有取票网关 mock，没有账号控制面，当前 Registry 会正确判定无闲时
  // 模型，导致 OffPeakCreate 不曝光。复用正常账号解析前置，不在产品里塞静态名单。
  "conversation-session-offpeak-create.test.ts",
  "conversation-session-offpeak-create-existing-session.test.ts",
  "conversation-session-offpeak-subagent-model-inheritance.test.ts",
  "conversation-session-off-peak-invalid-ticket.test.ts",
  "off-peak-create-manage.test.ts",
] as const;

export function shouldPrepareCodingPlanTeamMock(specs: readonly string[]) {
  return specs.some((spec) => {
    const normalized = spec.replaceAll("\\", "/");
    return (
      normalized === DEFAULT_FULL_E2E_SPEC_GLOB ||
      CODING_PLAN_TEAM_SPEC_MARKERS.some((marker) => normalized.includes(marker))
    );
  });
}

export function applyCodingPlanTeamMockEnv(environment: MutableEnvironment, baseUrl: string) {
  environment[CODING_PLAN_TEAM_MOCK_BASE_URL_ENV] = baseUrl;
  environment.ZCODE_ENV = "test";
  for (const key of CODING_PLAN_COMMON_ENV_KEYS) {
    environment[key] = baseUrl;
  }
  environment.ZCODE_BIGMODEL_USAGE_QUOTA_URL = `${baseUrl}/api/monitor/usage/quota/limit`;
  environment.BIGMODEL_USAGE_QUOTA_URL = `${baseUrl}/api/monitor/usage/quota/limit`;
}

export function clearCodingPlanTeamMockEnv(environment: MutableEnvironment, baseUrl: string) {
  clearOwnedEnvironmentValues(environment, baseUrl, [
    ...CODING_PLAN_COMMON_ENV_KEYS,
    "ZCODE_BIGMODEL_USAGE_QUOTA_URL",
    "BIGMODEL_USAGE_QUOTA_URL",
  ]);
  if (environment[CODING_PLAN_TEAM_MOCK_BASE_URL_ENV] === baseUrl) {
    delete environment[CODING_PLAN_TEAM_MOCK_BASE_URL_ENV];
  }
}

export function applyCodingPlanUpgradeMockEnv(environment: MutableEnvironment, baseUrl: string) {
  environment[CODING_PLAN_UPGRADE_MOCK_BASE_URL_ENV] = baseUrl;
  for (const key of CODING_PLAN_COMMON_ENV_KEYS) {
    environment[key] = baseUrl;
  }
  environment.BIGMODEL_TEST_API_BASE_URL = baseUrl;
  environment.VITE_CODING_PLAN_WEBVIEW_ORIGIN = baseUrl;
  environment.ZAI_BUSINESS_BASE_URL = baseUrl;
}

export function clearCodingPlanUpgradeMockEnv(environment: MutableEnvironment, baseUrl: string) {
  clearOwnedEnvironmentValues(environment, baseUrl, [
    ...CODING_PLAN_COMMON_ENV_KEYS,
    "BIGMODEL_TEST_API_BASE_URL",
    "VITE_CODING_PLAN_WEBVIEW_ORIGIN",
    "ZAI_BUSINESS_BASE_URL",
  ]);
  if (environment[CODING_PLAN_UPGRADE_MOCK_BASE_URL_ENV] === baseUrl) {
    delete environment[CODING_PLAN_UPGRADE_MOCK_BASE_URL_ENV];
  }
}

function clearOwnedEnvironmentValues(
  environment: MutableEnvironment,
  baseUrl: string,
  keys: readonly string[],
) {
  const ownedValues = new Set([baseUrl, `${baseUrl}/api/monitor/usage/quota/limit`]);
  for (const key of keys) {
    if (ownedValues.has(environment[key] ?? "")) {
      delete environment[key];
    }
  }
}
