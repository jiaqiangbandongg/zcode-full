import type {
  E2ELifecycleEvent,
  E2ELifecyclePhase,
} from "../reporting/e2e-reporting-types.js";

export async function runMeasuredE2ELifecyclePhase<T>(
  phase: E2ELifecyclePhase,
  context: { cid?: string; specs?: string[] },
  record: (event: E2ELifecycleEvent) => void,
  run: () => Promise<T> | T,
): Promise<T> {
  const startedAt = new Date();
  let failed = false;
  let failure: unknown = null;
  try {
    return await run();
  } catch (error) {
    failed = true;
    failure = error;
    throw error;
  } finally {
    const completedAt = new Date();
    record({
      cid: context.cid,
      completedAt: completedAt.toISOString(),
      durationMs: completedAt.getTime() - startedAt.getTime(),
      error: failed ? formatErrorMessage(failure) : undefined,
      phase,
      specs: context.specs ?? [],
      startedAt: startedAt.toISOString(),
      status: failed ? "failed" : "passed",
    });
  }
}

function formatErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
