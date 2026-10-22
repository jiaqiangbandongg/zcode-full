export function withE2EDesktopBuildLock<T>(
  options: { lockPath?: string; retryDelayMs?: number; timeoutMs?: number },
  action: () => T,
): T;
