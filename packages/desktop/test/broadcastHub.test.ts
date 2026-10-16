import { EventEmitter } from "node:events";
import type { UtilityProcess as ElectronUtilityProcess } from "electron";
import { describe, expect, it, vi } from "vitest";
import { HostMessageTypes, HostResponseTypes } from "@zcode/shared";
import { BroadcastHub } from "../src/main/broadcastHub.js";

class FakeHostProcess extends EventEmitter {
  readonly postedMessages: unknown[] = [];

  postMessage(message: unknown): void {
    this.postedMessages.push(message);
  }

  emitMessage(message: unknown): void {
    this.emit("message", message);
  }
}

function asUtilityProcess(process: FakeHostProcess): ElectronUtilityProcess {
  return process as unknown as ElectronUtilityProcess;
}

function claimRequest(requestId: string, key: string) {
  return {
    type: HostResponseTypes.BroadcastClaimRequest,
    requestId,
    key,
  };
}

function claimRelease(key: string, claimToken: string) {
  return {
    type: HostResponseTypes.BroadcastClaimRelease,
    key,
    claimToken,
  };
}

function claimCommit(key: string, claimToken: string) {
  return {
    type: HostResponseTypes.BroadcastClaimCommit,
    key,
    claimToken,
  };
}

describe("BroadcastHub claim", () => {
  it("两个窗口 claim 同一 key 时严格 first-wins", () => {
    const first = new FakeHostProcess();
    const second = new FakeHostProcess();
    const hub = new BroadcastHub();
    hub.register(1, asUtilityProcess(first));
    hub.register(2, asUtilityProcess(second));

    first.emitMessage(claimRequest("req-a", "quota-reset:same"));
    second.emitMessage(claimRequest("req-b", "quota-reset:same"));

    expect(first.postedMessages).toEqual([
      expect.objectContaining({
        type: HostMessageTypes.BroadcastClaimResult,
        requestId: "req-a",
        status: "acquired",
        claimToken: expect.any(String),
      }),
    ]);
    expect(second.postedMessages).toEqual([
      expect.objectContaining({
        type: HostMessageTypes.BroadcastClaimResult,
        requestId: "req-b",
        status: "busy",
        retryAfterMs: expect.any(Number),
      }),
    ]);
  });

  it("同一窗口重复 key 失败，不同 key 仍可成功", () => {
    const host = new FakeHostProcess();
    const hub = new BroadcastHub();
    hub.register(1, asUtilityProcess(host));

    host.emitMessage(claimRequest("req-a", "quota-reset:a"));
    host.emitMessage(claimRequest("req-b", "quota-reset:a"));
    host.emitMessage(claimRequest("req-c", "quota-reset:b"));

    expect(host.postedMessages).toEqual([
      expect.objectContaining({ requestId: "req-a", status: "acquired" }),
      expect.objectContaining({ requestId: "req-b", status: "busy" }),
      expect.objectContaining({ requestId: "req-c", status: "acquired" }),
    ]);
  });

  it("未 commit reservation 可按 token 释放，迟到 token 不会释放后来 winner", () => {
    const first = new FakeHostProcess();
    const second = new FakeHostProcess();
    const hub = new BroadcastHub();
    hub.register(1, asUtilityProcess(first));
    hub.register(2, asUtilityProcess(second));

    first.emitMessage(claimRequest("req-a", "quota-reset:same"));
    const firstToken = (first.postedMessages[0] as { claimToken: string }).claimToken;
    first.emitMessage(claimRelease("quota-reset:same", firstToken));

    second.emitMessage(claimRequest("req-b", "quota-reset:same"));
    const secondResult = second.postedMessages[0] as { status: string; claimToken: string };
    expect(secondResult.status).toBe("acquired");

    first.emitMessage(claimRelease("quota-reset:same", firstToken));
    first.emitMessage(claimRequest("req-c", "quota-reset:same"));
    expect(first.postedMessages.at(-1)).toEqual(
      expect.objectContaining({ requestId: "req-c", status: "busy" }),
    );
  });

  it("commit 后 reservation 变为永久 claim，后续窗口只能等待真实 played", () => {
    const first = new FakeHostProcess();
    const second = new FakeHostProcess();
    const hub = new BroadcastHub();
    hub.register(1, asUtilityProcess(first));
    hub.register(2, asUtilityProcess(second));

    first.emitMessage(claimRequest("req-a", "quota-reset:same"));
    const token = (first.postedMessages[0] as { claimToken: string }).claimToken;
    first.emitMessage(claimCommit("quota-reset:same", token));
    first.emitMessage(claimRelease("quota-reset:same", token));
    second.emitMessage(claimRequest("req-b", "quota-reset:same"));

    expect(second.postedMessages).toEqual([
      expect.objectContaining({ requestId: "req-b", status: "committed" }),
    ]);
  });

  it("窗口注销时释放该窗口尚未 commit 的 reservation", () => {
    const first = new FakeHostProcess();
    const second = new FakeHostProcess();
    const hub = new BroadcastHub();
    hub.register(1, asUtilityProcess(first));
    hub.register(2, asUtilityProcess(second));

    first.emitMessage(claimRequest("req-a", "quota-reset:same"));
    hub.unregister(1);
    second.emitMessage(claimRequest("req-b", "quota-reset:same"));

    expect(second.postedMessages).toEqual([
      expect.objectContaining({ requestId: "req-b", status: "acquired" }),
    ]);
  });

  it("未 commit reservation 超过 TTL 后由下一次 acquire 回收", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-17T00:00:00.000Z"));
      const first = new FakeHostProcess();
      const second = new FakeHostProcess();
      const hub = new BroadcastHub();
      hub.register(1, asUtilityProcess(first));
      hub.register(2, asUtilityProcess(second));

      first.emitMessage(claimRequest("req-a", "quota-reset:same"));
      vi.setSystemTime(new Date("2026-08-17T00:00:06.000Z"));
      second.emitMessage(claimRequest("req-b", "quota-reset:same"));

      expect(second.postedMessages).toEqual([
        expect.objectContaining({ requestId: "req-b", status: "acquired" }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("BroadcastHub.collectMemoryDiagnostics", () => {
  it("返回 claims / processes 的只读大小", () => {
    const hub = new BroadcastHub();
    expect(hub.collectMemoryDiagnostics()).toEqual({ claims: 0, processes: 0 });
  });
});
