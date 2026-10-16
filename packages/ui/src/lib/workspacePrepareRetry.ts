import { isNonRetryableWorkspacePrepareError, type ZCodeProvider } from "@zcode/shared";

export function shouldAutoRetryWorkspacePrepare(errorMessage: string) {
  // Bugfix: 远端 ZCode Agent 在 Docker 里经常会因为资源不匹配、可选依赖缺失或进程启动即退出而失败。
  // 这些错误之前没有命中“不可自动重试”名单，草稿态预热会不断回到 loading，用户看起来像永远卡住。
  // 这里把“初始化前退出/超时/依赖缺失”统一视为确定性失败，停止自动重试，让 UI 尽快落成 failed。
  // Bugfix: provider 未登录时 prepareWorkspace 会触发 OAuth；若用户未完成登录，
  // 之前自动重试会不断重复拉起同一流程，造成“反复弹登录/一直 loading”。
  // 这里把鉴权缺失/登录超时也视为不可自动重试，改为交给用户手动重试触发下一次登录。
  // Bugfix: 不可重试错误模式同时影响 UI 自动重试与 service MCP-fallback。
  // 这里复用 shared 中央定义，避免两端各维护一份字符串列表后再次漏同步。
  return !isNonRetryableWorkspacePrepareError(errorMessage);
}

export function shouldRestartWorkspaceProcessBeforePrepareRetry(_params: {
  provider: ZCodeProvider;
  errorMessage: string;
}): boolean {
  // 仅剩 glm provider：不再需要针对三方 CLI 崩溃文案的重启重试策略。
  return false;
}
