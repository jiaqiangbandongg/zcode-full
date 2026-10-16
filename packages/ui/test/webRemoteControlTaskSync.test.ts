import { describe, expect, it, vi } from "vitest";
import {
  logDeferredWebRemoteControlTaskSnapshot,
  shouldSyncWebRemoteControlTaskSnapshot,
} from "@/lib/webRemoteControlTaskSync.js";

describe("shouldSyncWebRemoteControlTaskSnapshot", () => {
  it("defers empty task snapshots while the remote-control task queries are loading", () => {
    expect(
      shouldSyncWebRemoteControlTaskSnapshot({
        enabled: true,
        archivedLoading: false,
        pinnedLoading: false,
        timelineLoading: true,
      }),
    ).toBe(false);
  });

  it("allows a loaded empty snapshot so main can clear stale tasks", () => {
    expect(
      shouldSyncWebRemoteControlTaskSnapshot({
        enabled: true,
        archivedLoading: false,
        pinnedLoading: false,
        timelineLoading: false,
      }),
    ).toBe(true);
  });

  it("defers non-empty task snapshots while any remote-control task query is still loading", () => {
    expect(
      shouldSyncWebRemoteControlTaskSnapshot({
        enabled: true,
        archivedLoading: false,
        pinnedLoading: true,
        timelineLoading: true,
      }),
    ).toBe(false);
  });

  it("defers snapshots while archived remote-control task query is still loading", () => {
    expect(
      shouldSyncWebRemoteControlTaskSnapshot({
        enabled: true,
        archivedLoading: true,
        pinnedLoading: false,
        timelineLoading: false,
      }),
    ).toBe(false);
  });

  it("logs deferred partial snapshots as debug without calling them empty snapshots", () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
    };

    logDeferredWebRemoteControlTaskSnapshot(logger, {
      archivedLoading: false,
      pinnedLoading: true,
      timelineLoading: false,
    });

    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith(
      expect.not.stringContaining("空任务快照"),
      {
        archivedLoading: false,
        pinnedLoading: true,
        timelineLoading: false,
      },
    );
  });
});
