export interface E2ERendererBridgeRootHooks {
  beforeAll: () => Promise<void>;
}

export function createE2ERendererBridgeRootHooks(
  runPreflight: () => Promise<void>,
  readBeforeSessionError: () => unknown = () => null,
): E2ERendererBridgeRootHooks {
  return {
    // Bug 根因：WDIO config hooks 会记录普通异常后 resolve，无法阻止坏 session 继续跑 case。
    // 使用 Mocha 原生 root hook，让 preflight rejection 成为真正的 root-hook failure。
    async beforeAll() {
      const beforeSessionError = readBeforeSessionError();
      if (beforeSessionError !== null) {
        throw new Error(
          `e2e-before-session infra failure: ${formatErrorMessage(beforeSessionError)}`,
          beforeSessionError instanceof Error ? { cause: beforeSessionError } : undefined,
        );
      }
      await runPreflight();
    },
  };
}

function formatErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
