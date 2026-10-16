export interface ManualClaimReleaseRepo {
  get(
    automationId: string,
  ): Promise<{ workspaceKey: string } | null>;
  getRun(runId: string): Promise<{ workspaceKey: string } | null>;
  releaseManualClaim(automationId: string, workspaceKey: string): Promise<void>;
}

export interface ManualClaimReleaseParams {
  repo: ManualClaimReleaseRepo;
  automationId: string;
  runId: string;
  workspaceKey?: string;
  logError: (message: string) => void;
}

export async function releaseManualClaimForSettledRun(
  params: ManualClaimReleaseParams,
): Promise<void> {
  const releaseWorkspaceKey =
    params.workspaceKey ??
    (await params.repo.getRun(params.runId).then((run) => run?.workspaceKey)) ??
    (await params.repo.get(params.automationId).then((automation) => automation?.workspaceKey));
  if (!releaseWorkspaceKey) {
    params.logError(
      `manual claim release skipped: workspaceKey missing automation=${params.automationId} runId=${params.runId}`,
    );
    return;
  }
  // scheduler 重启 / inFlight 丢失后仍可能收到 main 的迟到回报；manual
  // single-flight 锁必须用 run 台账或 automation 兜回 workspaceKey，否则会卡到 stale 回收。
  await params.repo.releaseManualClaim(params.automationId, releaseWorkspaceKey);
}

export async function settleManualClaimForDispatchResult(
  params: ManualClaimReleaseParams & { ok: boolean },
): Promise<void> {
  // host ok 只表示 prompt accepted/queued，真实终态由 host subscription
  // 收口；scheduler 仅在派发失败、没有可等待 turn 时释放 manual claim。
  if (params.ok) return;
  await releaseManualClaimForSettledRun(params);
}
