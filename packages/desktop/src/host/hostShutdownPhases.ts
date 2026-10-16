export interface HostShutdownPhase {
  name: string;
  run: () => Promise<void>;
  timeoutMs?: number;
}

export interface HostShutdownResult {
  exitCode: 0 | 1;
  failedPhases: string[];
  timedOutPhases: string[];
}

interface HostShutdownPhaseOptions {
  phaseTimeoutMs: number;
  log: (message: string, details: Record<string, unknown>) => void;
}

export async function runHostShutdownPhases(
  phases: HostShutdownPhase[],
  options: HostShutdownPhaseOptions,
): Promise<HostShutdownResult> {
  const failedPhases: string[] = [];
  const timedOutPhases: string[] = [];

  for (const phase of phases) {
    const startedAt = Date.now();
    const timeoutMs = Math.max(phase.timeoutMs ?? options.phaseTimeoutMs, 0);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const operation = phase.run().then(
      () => ({ kind: "completed" as const }),
      (error: unknown) => ({ kind: "failed" as const, error }),
    );
    const deadline = new Promise<{ kind: "timed-out" }>((resolve) => {
      timeout = setTimeout(() => resolve({ kind: "timed-out" }), timeoutMs);
    });
    const result = await Promise.race([operation, deadline]);
    if (timeout) {
      clearTimeout(timeout);
    }

    if (result.kind === "timed-out") {
      timedOutPhases.push(phase.name);
      options.log("host shutdown phase timed out", {
        elapsedMs: Date.now() - startedAt,
        phase: phase.name,
        timeoutMs,
      });
      continue;
    }
    if (result.kind === "failed") {
      failedPhases.push(phase.name);
      options.log("host shutdown phase failed", {
        elapsedMs: Date.now() - startedAt,
        error: result.error,
        phase: phase.name,
      });
    }
  }

  return {
    exitCode: failedPhases.length > 0 || timedOutPhases.length > 0 ? 1 : 0,
    failedPhases,
    timedOutPhases,
  };
}
