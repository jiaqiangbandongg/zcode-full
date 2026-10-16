import { describe, expect, it, vi } from "vitest";
import {
  releaseManualClaimForSettledRun,
  settleManualClaimForDispatchResult,
} from "../src/scheduler/manualClaimRelease.js";

describe("desktop cron scheduler manual claim release", () => {
  it("host ACK 保留 manual claim，派发失败才释放", async () => {
    const repo = {
      get: vi.fn(async () => ({ workspaceKey: "fallback-workspace" })),
      getRun: vi.fn(async () => ({ workspaceKey: "run-workspace" })),
      releaseManualClaim: vi.fn(async () => {}),
    };
    const params = {
      repo,
      automationId: "automation-1",
      runId: "automation-1:manual:recovered",
      workspaceKey: "run-workspace",
      logError: vi.fn(),
    };

    await settleManualClaimForDispatchResult({ ...params, ok: true });

    expect(repo.releaseManualClaim).not.toHaveBeenCalled();
    expect(repo.getRun).not.toHaveBeenCalled();
    expect(repo.get).not.toHaveBeenCalled();

    await settleManualClaimForDispatchResult({ ...params, ok: false });

    expect(repo.releaseManualClaim).toHaveBeenCalledTimes(1);
    expect(repo.releaseManualClaim).toHaveBeenCalledWith(
      "automation-1",
      "run-workspace",
    );
  });

  it("inFlight 丢失时从 run 台账恢复 workspaceKey 并释放 manual claim", async () => {
    const repo = {
      get: vi.fn(async () => ({ workspaceKey: "fallback-workspace" })),
      getRun: vi.fn(async () => ({ workspaceKey: "run-workspace" })),
      releaseManualClaim: vi.fn(async () => {}),
    };
    const logError = vi.fn();

    await releaseManualClaimForSettledRun({
      repo,
      automationId: "automation-1",
      runId: "automation-1:manual:late",
      logError,
    });

    expect(repo.getRun).toHaveBeenCalledWith("automation-1:manual:late");
    expect(repo.get).not.toHaveBeenCalled();
    expect(repo.releaseManualClaim).toHaveBeenCalledWith("automation-1", "run-workspace");
    expect(logError).not.toHaveBeenCalled();
  });

  it("run 台账缺失时回退 automation workspaceKey，仍失败则打 error", async () => {
    const repo = {
      get: vi.fn(async () => ({ workspaceKey: "automation-workspace" })),
      getRun: vi.fn(async () => null),
      releaseManualClaim: vi.fn(async () => {}),
    };
    const logError = vi.fn();

    await releaseManualClaimForSettledRun({
      repo,
      automationId: "automation-1",
      runId: "automation-1:manual:late",
      logError,
    });

    expect(repo.releaseManualClaim).toHaveBeenCalledWith(
      "automation-1",
      "automation-workspace",
    );
    expect(logError).not.toHaveBeenCalled();

    repo.get.mockResolvedValueOnce(null);
    await releaseManualClaimForSettledRun({
      repo,
      automationId: "automation-missing",
      runId: "automation-missing:manual:late",
      logError,
    });

    expect(logError).toHaveBeenCalledWith(
      "manual claim release skipped: workspaceKey missing automation=automation-missing runId=automation-missing:manual:late",
    );
  });
});
