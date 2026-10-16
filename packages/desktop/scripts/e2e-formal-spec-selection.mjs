export const SSH_FORMAL_SPEC_GLOB =
  "./test/e2e/conversation-session/conversation-session-ssh-remote*.test.ts";

const REQUIRED_SSH_E2E_ENV = [
  "ZCODE_E2E_SSH_HOST",
  "ZCODE_E2E_SSH_USERNAME",
  "ZCODE_E2E_SSH_PASSWORD",
];

export function hasRequiredSshE2EEnvironment(env) {
  return REQUIRED_SSH_E2E_ENV.every((name) => env[name]?.trim());
}

export function isSshFormalSpec(spec) {
  return spec
    .replaceAll("\\", "/")
    .includes("/conversation-session/conversation-session-ssh-remote");
}

export function resolveEnvironmentGatedFormalSpecExcludes({ env, targeted }) {
  // 修复原因：SSH P0 依赖真实服务器，默认全量在无凭据时纳入只会把环境缺失
  // 误记为三个产品失败；显式定向运行仍保留 helper 的缺变量 fail-closed 提示。
  return !targeted && !hasRequiredSshE2EEnvironment(env)
    ? [SSH_FORMAL_SPEC_GLOB]
    : [];
}
