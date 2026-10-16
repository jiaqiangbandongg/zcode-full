import { describe, expect, it, vi } from "vitest";
import { HostMessageTypes, HostResponseTypes } from "@zcode/shared";
import { createBroadcastService } from "../src/broadcast/broadcastService.js";

class FakeParentPort {
  readonly postedMessages: unknown[] = [];
  private readonly listeners = new Set<(event: { data: unknown }) => void>();

  postMessage(message: unknown): void {
    this.postedMessages.push(message);
  }

  on(_event: "message", listener: (event: { data: unknown }) => void): void {
    this.listeners.add(listener);
  }

  emit(message: unknown): void {
    for (const listener of this.listeners) {
      listener({ data: message });
    }
  }
}

describe("createBroadcastService tryClaim", () => {
  it("无 parentPort 时同一 key 只有第一次 claim 成功", async () => {
    const service = createBroadcastService(null);

    await expect(service.tryClaim("quota-reset:a")).resolves.toBe(true);
    await expect(service.tryClaim("quota-reset:a")).resolves.toBe(false);
    await expect(service.tryClaim("quota-reset:b")).resolves.toBe(true);
  });

  it("通过 requestId 等待 main 返回原子 claim 结果", async () => {
    const parentPort = new FakeParentPort();
    const service = createBroadcastService(parentPort);

    const pending = service.tryClaim("quota-reset:a");
    expect(parentPort.postedMessages).toHaveLength(1);
    const request = parentPort.postedMessages[0] as {
      type: string;
      requestId: string;
      key: string;
    };
    expect(request).toMatchObject({
      type: HostResponseTypes.BroadcastClaimRequest,
      key: "quota-reset:a",
    });

    parentPort.emit({
      type: HostMessageTypes.BroadcastClaimResult,
      requestId: request.requestId,
      status: "acquired",
      claimToken: "token-a",
    });

    await expect(pending).resolves.toBe(true);
  });

  it("acquire/release 使用 token，release 后可重新 reservation", async () => {
    const service = createBroadcastService(null);

    const first = await service.acquireClaim("quota-reset:a");
    expect(first).toEqual({
      status: "acquired",
      lease: expect.objectContaining({ key: "quota-reset:a", token: expect.any(String) }),
    });
    if (first.status !== "acquired") {
      throw new Error("expected acquired claim");
    }
    await service.releaseClaim(first.lease);

    await expect(service.acquireClaim("quota-reset:a")).resolves.toEqual({
      status: "acquired",
      lease: expect.objectContaining({ key: "quota-reset:a", token: expect.any(String) }),
    });
  });

  it("commit 后 release 不再删除永久 claim", async () => {
    const service = createBroadcastService(null);
    const first = await service.acquireClaim("quota-reset:a");
    if (first.status !== "acquired") {
      throw new Error("expected acquired claim");
    }

    await service.commitClaim(first.lease);
    await service.releaseClaim(first.lease);

    await expect(service.acquireClaim("quota-reset:a")).resolves.toEqual({
      status: "committed",
    });
  });

  it("main 未响应时超时返回 false，避免重复播放", async () => {
    vi.useFakeTimers();
    try {
      const service = createBroadcastService(new FakeParentPort());
      const pending = service.tryClaim("quota-reset:a");

      await vi.runAllTimersAsync();
      await expect(pending).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("acquire 超时后收到迟到 winner 时主动 release reservation", async () => {
    vi.useFakeTimers();
    try {
      const parentPort = new FakeParentPort();
      const service = createBroadcastService(parentPort);
      const pending = service.acquireClaim("quota-reset:a");
      const request = parentPort.postedMessages[0] as { requestId: string };

      await vi.advanceTimersByTimeAsync(2_000);
      await expect(pending).resolves.toEqual({ status: "unavailable" });
      parentPort.emit({
        type: HostMessageTypes.BroadcastClaimResult,
        requestId: request.requestId,
        status: "acquired",
        claimToken: "late-token",
      });

      expect(parentPort.postedMessages.at(-1)).toEqual({
        type: HostResponseTypes.BroadcastClaimRelease,
        key: "quota-reset:a",
        claimToken: "late-token",
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
