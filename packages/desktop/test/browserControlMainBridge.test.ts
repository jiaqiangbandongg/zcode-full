import { describe, expect, it, vi } from "vitest";
import {
  createBrowserControlMainBridge,
  type BrowserExecuteRequestMessage,
} from "../src/host/browserControlMainBridge.js";
import type { BrowserCommand, BrowserCommandResult } from "@zcode/contracts";

const NAV: BrowserCommand = { method: "navigate", url: "https://example.com" };

describe("browserControlMainBridge", () => {
  it("posts a request to main and resolves on matching result", async () => {
    const posted: BrowserExecuteRequestMessage[] = [];
    const bridge = createBrowserControlMainBridge({
      postToMain: (m) => posted.push(m),
    });
    const [descriptor] = await bridge.list();
    expect(descriptor).toMatchObject({
      type: "iab",
      name: "ZCode In-app Browser",
      generation: expect.any(Number),
      capabilities: {
        browser: [expect.objectContaining({ id: "visibility" })],
        tab: [],
      },
      apiSupportOverrides: {
        "BrowserUser.claimTab": true,
        "Tabs.finalize": true,
        "Tab.markDeliverable": true,
        "Tab.markHandoff": true,
        "BrowserRecordingAPI.start": true,
        "BrowserRecordingAPI.status": true,
        "BrowserRecordingAPI.cancel": true,
      },
    });
    const promise = bridge.execute({
      browserId: descriptor.id,
      sessionId: "s1",
      workspaceKey: "/workspace",
      workspacePath: "/workspace",
      command: NAV,
    });
    expect(posted).toHaveLength(1);
    const { requestId, browserId, command } = posted[0];
    expect(browserId).toBe(descriptor.id);
    expect(posted[0].browserGeneration).toBe(descriptor.generation);
    expect(command).toEqual(NAV);
    const result: BrowserCommandResult = {
      ok: true,
      state: { url: "https://example.com", title: "E", canGoBack: false, canGoForward: false },
      elapsedMs: 5,
    };
    bridge.handleResult({ requestId, result });
    await expect(promise).resolves.toMatchObject({ ok: true });
    bridge.dispose();
  });

  it("materializes a completed recording into the workspace before exposing its path", async () => {
    const posted: BrowserExecuteRequestMessage[] = [];
    const materializeRecording = vi.fn(async (input) => ({
      ...input.artifact,
      path: "/workspace/recordings/demo.webm",
    }));
    const bridge = createBrowserControlMainBridge({
      postToMain: (message) => posted.push(message),
      materializeRecording,
    });
    const promise = bridge.execute({
      sessionId: "s1",
      workspaceKey: "/workspace",
      workspacePath: "/workspace",
      command: {
        method: "recordingStatus",
        recordingId: "recording-1",
        outputPath: "recordings/demo.webm",
      },
    });
    const requestId = posted[0]!.requestId;

    await bridge.handleResult({
      requestId,
      result: {
        ok: true,
        recording: {
          id: "recording-1",
          status: "completed",
          phase: "completed",
          progress: 1,
          startedAt: 1,
          updatedAt: 2,
          artifact: {
            path: "/tmp/zcode-recording.webm",
            mimeType: "video/webm",
            width: 1280,
            height: 720,
            fps: 25,
            durationMs: 1_000,
            frameCount: 25,
          },
        },
        elapsedMs: 1,
      },
    });

    await expect(promise).resolves.toMatchObject({
      recording: { artifact: { path: "/workspace/recordings/demo.webm" } },
    });
    expect(materializeRecording).toHaveBeenCalledWith(
      expect.objectContaining({
        outputPath: "recordings/demo.webm",
        workspacePath: "/workspace",
        localPath: "/tmp/zcode-recording.webm",
      }),
    );
    bridge.dispose();
  });

  it("correlates concurrent requests by requestId (no cross-talk)", async () => {
    const posted: BrowserExecuteRequestMessage[] = [];
    const bridge = createBrowserControlMainBridge({ postToMain: (m) => posted.push(m) });
    const pA = bridge.execute({ sessionId: "s1", command: { method: "getState" } });
    const pB = bridge.execute({ sessionId: "s1", command: { method: "snapshot" } });
    const [idA, idB] = posted.map((m) => m.requestId);
    // 先回 B。
    bridge.handleResult({
      requestId: idB,
      result: {
        ok: true,
        snapshot: { url: "u", title: "t", elements: [], truncated: false },
        elapsedMs: 1,
      },
    });
    bridge.handleResult({
      requestId: idA,
      result: {
        ok: true,
        state: { url: "u", title: "t", canGoBack: false, canGoForward: false },
        elapsedMs: 1,
      },
    });
    const [rA, rB] = await Promise.all([pA, pB]);
    expect(rA.state).toBeDefined();
    expect(rA.snapshot).toBeUndefined();
    expect(rB.snapshot).toBeDefined();
    bridge.dispose();
  });

  it("rejects a concurrent duplicate requestId in the same scope without replacing the original", async () => {
    const posted: BrowserExecuteRequestMessage[] = [];
    const bridge = createBrowserControlMainBridge({ postToMain: (message) => posted.push(message) });
    const original = bridge.execute({
      requestId: "duplicate",
      sessionId: "s1",
      command: { method: "getState" },
    });

    await expect(
      bridge.execute({
        requestId: "duplicate",
        sessionId: "s1",
        command: { method: "snapshot" },
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "duplicate_request_id", sideEffect: "none" },
    });
    expect(posted).toHaveLength(1);

    bridge.handleResult({
      requestId: "duplicate",
      result: {
        ok: true,
        state: { url: "original", title: "Original", canGoBack: false, canGoForward: false },
        elapsedMs: 1,
      },
    });
    await expect(original).resolves.toMatchObject({ ok: true, state: { url: "original" } });
    bridge.dispose();
  });

  it("rejects a concurrent duplicate requestId across scopes because result routing is global", async () => {
    const posted: BrowserExecuteRequestMessage[] = [];
    const bridge = createBrowserControlMainBridge({ postToMain: (message) => posted.push(message) });
    const original = bridge.execute({
      requestId: "cross-scope-duplicate",
      sessionId: "s1",
      command: { method: "getState" },
    });

    await expect(
      bridge.execute({
        requestId: "cross-scope-duplicate",
        sessionId: "s2",
        command: { method: "snapshot" },
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "duplicate_request_id", sideEffect: "none" },
    });
    expect(posted).toHaveLength(1);

    bridge.handleResult({
      requestId: "cross-scope-duplicate",
      result: {
        ok: true,
        state: { url: "original", title: "Original", canGoBack: false, canGoForward: false },
        elapsedMs: 1,
      },
    });
    await expect(original).resolves.toMatchObject({ ok: true, state: { url: "original" } });
    bridge.dispose();
  });

  it("times out to a structured error when main never replies", async () => {
    vi.useFakeTimers();
    try {
      const posted: BrowserExecuteRequestMessage[] = [];
      const bridge = createBrowserControlMainBridge({
        postToMain: (message) => posted.push(message),
        timeoutMs: 1000,
      });
      const promise = bridge.execute({ sessionId: "s1", command: NAV });
      await vi.advanceTimersByTimeAsync(1001);
      const result = await promise;
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("timeout");
      expect(result.error?.sideEffect).toBe("uncertain");
      expect(posted).toHaveLength(2);
      expect(posted[1]?.command).toEqual({
        method: "cancelRequest",
        requestId: posted[0]?.requestId,
      });
      bridge.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the requested wait duration plus 2s as waitForTimeout transport budget", async () => {
    vi.useFakeTimers();
    try {
      const bridge = createBrowserControlMainBridge({ postToMain: () => {}, timeoutMs: 1000 });
      let settled = false;
      const promise = bridge
        .execute({
          sessionId: "s1",
          command: { method: "playwrightWaitForTimeout", timeoutMs: 5_000 },
        })
        .then((result) => {
          settled = true;
          return result;
        });

      await vi.advanceTimersByTimeAsync(6_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      await expect(promise).resolves.toMatchObject({
        ok: false,
        error: { code: "timeout", message: expect.stringContaining("7000ms") },
      });
      bridge.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves backend_unavailable when postToMain throws", async () => {
    const bridge = createBrowserControlMainBridge({
      postToMain: () => {
        throw new Error("no channel");
      },
    });
    const result = await bridge.execute({ sessionId: "s1", command: NAV });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("backend_unavailable");
    bridge.dispose();
  });

  it("rejects a stale browser id before posting to main", async () => {
    const postToMain = vi.fn();
    const bridge = createBrowserControlMainBridge({ postToMain });
    const result = await bridge.execute({
      browserId: "iab:stale",
      sessionId: "s1",
      command: NAV,
    });
    expect(result).toMatchObject({ ok: false, error: { code: "backend_unavailable" } });
    expect(postToMain).not.toHaveBeenCalled();
    bridge.dispose();
  });

  it("rejects a stale browser generation before posting to main", async () => {
    const postToMain = vi.fn();
    const bridge = createBrowserControlMainBridge({ postToMain });
    const [descriptor] = await bridge.list();
    const result = await bridge.execute({
      browserId: descriptor.id,
      browserGeneration: descriptor.generation + 1,
      sessionId: "s1",
      command: NAV,
    });
    expect(result).toMatchObject({ ok: false, error: { code: "backend_unavailable" } });
    expect(postToMain).not.toHaveBeenCalled();
    bridge.dispose();
  });

  it("ignores late results after timeout without throwing", async () => {
    const bridge = createBrowserControlMainBridge({ postToMain: () => {} });
    // 未知 requestId 的迟到结果应被安全忽略。
    expect(() =>
      bridge.handleResult({ requestId: "unknown", result: { ok: true, elapsedMs: 1 } }),
    ).not.toThrow();
    bridge.dispose();
  });

  it("dispose resolves pending commands instead of stranding promises", async () => {
    const bridge = createBrowserControlMainBridge({ postToMain: () => {} });
    const pending = bridge.execute({ sessionId: "s1", command: NAV });
    bridge.dispose();
    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { code: "backend_unavailable", sideEffect: "uncertain" },
    });
  });
});
