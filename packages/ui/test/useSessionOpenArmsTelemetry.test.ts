// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationOpenTiming, ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import type { SessionOpenRendererTiming } from "@/v4/conversationProjectionStore.js";
import {
  clearSessionOpenArmsReporterForTest,
  setSessionOpenArmsReporter,
} from "@/lib/sessionOpenArmsTelemetry.js";
import { useSessionOpenArmsTelemetry } from "@/v4/telemetry/useSessionOpenArmsTelemetry.js";

function snapshot(sessionId: string): ConversationSnapshot {
  return {
    sessionId,
    logEpoch: "epoch-1",
    seq: 1,
    revision: 1,
    rows: {
      firstRowId: 1,
      lastRowId: 1,
      window: [],
    },
  } as ConversationSnapshot;
}

describe("useSessionOpenArmsTelemetry", () => {
  afterEach(() => {
    clearSessionOpenArmsReporterForTest();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("reports one start and one result after the first painted snapshot", () => {
    const calls: Array<{
      name: string;
      value?: number;
      properties?: Record<string, string | number | boolean | undefined>;
    }> = [];
    setSessionOpenArmsReporter({
      reportArmsCustomEvent: vi.fn(async (payload) => {
        calls.push({ name: payload.name, value: payload.value, properties: payload.properties });
      }),
    });
    vi.useFakeTimers();
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});

    const { rerender } = renderHook(
      (props: {
        sessionId: string | null;
        snapshot: ConversationSnapshot | null;
        status: "connecting" | "live" | "error" | "closed";
        openTiming?: ConversationOpenTiming;
        rendererTiming?: SessionOpenRendererTiming;
      }) => useSessionOpenArmsTelemetry({ ...props, lastError: null }),
      {
        initialProps: { sessionId: "session-1", snapshot: null, status: "connecting" },
      },
    );

    expect(calls.map((call) => call.name)).toEqual(["perf_ui_session_open_start"]);

    act(() => {
      rerender({
        sessionId: "session-1",
        snapshot: snapshot("session-1"),
        status: "live",
        openTiming: {
          version: 1,
          providerRegistrySyncMs: 11,
          taskMetaReadMs: 12,
          cliRequestMs: 13,
          initialFrameEncodeMs: 14,
          cliSessionRestoreMs: 15,
          sessionRuntimeState: "cold",
          snapshotRowCount: 1,
        },
        rendererTiming: {
          rendererPrepareMs: 1,
          initialFrameTransportMs: 2,
          rendererSnapshotApplyMs: 3,
          snapshotAppliedAt: 4,
        },
      });
      vi.advanceTimersByTime(1);
    });

    expect(calls.map((call) => call.name)).toEqual([
      "perf_ui_session_open_start",
      "perf_ui_session_open_result",
    ]);
    expect(calls[1]?.value).toBeGreaterThanOrEqual(0);
    expect(calls[1]?.properties).toMatchObject({
      provider_registry_sync_ms: 11,
      task_meta_read_ms: 12,
      cli_request_ms: 13,
      initial_frame_encode_ms: 14,
      initial_frame_transport_ms: 2,
      renderer_snapshot_apply_ms: 3,
    });
  });

  it("uses the latest timing fields when the open watchdog expires", () => {
    const calls: Array<{
      name: string;
      properties?: Record<string, string | number | boolean | undefined>;
    }> = [];
    setSessionOpenArmsReporter({
      reportArmsCustomEvent: vi.fn(async (payload) => {
        calls.push({ name: payload.name, properties: payload.properties });
      }),
    });
    vi.useFakeTimers();

    const { rerender } = renderHook(
      (props: {
        sessionId: string | null;
        snapshot: ConversationSnapshot | null;
        status: "connecting" | "live" | "error" | "closed";
        openTiming?: ConversationOpenTiming;
        rendererTiming?: SessionOpenRendererTiming;
      }) => useSessionOpenArmsTelemetry({ ...props, lastError: null }),
      {
        initialProps: { sessionId: "session-timeout", snapshot: null, status: "connecting" },
      },
    );

    rerender({
      sessionId: "session-timeout",
      snapshot: null,
      status: "connecting",
      openTiming: {
        version: 1,
        hostPrepareMs: 10,
        providerRegistrySyncMs: 11,
        taskMetaReadMs: 12,
        cliRequestMs: 13,
        cliSessionRestoreMs: 14,
        initialFrameEncodeMs: 15,
        sessionRuntimeState: "cold",
        snapshotRowCount: 2,
      },
      rendererTiming: {
        rendererPrepareMs: 16,
        initialFrameTransportMs: 17,
        rendererSnapshotApplyMs: 18,
        snapshotAppliedAt: 19,
      },
    });

    vi.advanceTimersByTime(30_000);

    expect(calls.map((call) => call.name)).toEqual([
      "perf_ui_session_open_start",
      "perf_ui_session_open_result",
    ]);
    expect(calls[1]?.properties).toMatchObject({
      status: "timeout",
      host_prepare_ms: 10,
      provider_registry_sync_ms: 11,
      task_meta_read_ms: 12,
      cli_request_ms: 13,
      cli_session_restore_ms: 14,
      initial_frame_encode_ms: 15,
      renderer_prepare_ms: 16,
      initial_frame_transport_ms: 17,
      renderer_snapshot_apply_ms: 18,
    });
  });

  it("honors the acquired open kind and trigger, and skips read-only panes", () => {
    const calls: Array<{ name: string; properties?: Record<string, unknown> }> = [];
    setSessionOpenArmsReporter({
      reportArmsCustomEvent: vi.fn(async (payload) => {
        calls.push({ name: payload.name, properties: payload.properties });
      }),
    });

    const { rerender } = renderHook(
      (props: {
        sessionId: string | null;
        snapshot: ConversationSnapshot | null;
        status: "connecting" | "live" | "error" | "closed";
        openKind?: "cold" | "warm" | "keep_warm";
        openTrigger?: string;
        startedAt?: number;
        readOnly?: boolean;
      }) =>
        useSessionOpenArmsTelemetry({
          ...props,
          lastError: null,
          openKind: props.openKind,
          openTrigger: props.openTrigger,
          startedAt: props.startedAt,
          readOnly: props.readOnly,
        }),
      {
        initialProps: {
          sessionId: "session-keep-warm",
          snapshot: null,
          status: "connecting",
          openKind: "keep_warm",
          openTrigger: "sidebar",
          startedAt: 1,
        },
      },
    );

    expect(calls[0]?.properties).toMatchObject({
      open_kind: "keep_warm",
      open_trigger: "sidebar",
    });

    rerender({
      sessionId: "session-read-only",
      snapshot: null,
      status: "connecting",
      readOnly: true,
    });
    expect(calls.filter((call) => call.name === "perf_ui_session_open_start")).toHaveLength(1);
  });

  it("does not reuse prior frame timing for a keep-warm open", () => {
    const calls: Array<{
      name: string;
      properties?: Record<string, string | number | boolean | undefined>;
    }> = [];
    setSessionOpenArmsReporter({
      reportArmsCustomEvent: vi.fn(async (payload) => {
        calls.push({ name: payload.name, properties: payload.properties });
      }),
    });
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});

    renderHook(() =>
      useSessionOpenArmsTelemetry({
        sessionId: "session-keep-warm",
        snapshot: snapshot("session-keep-warm"),
        openKind: "keep_warm",
        openTiming: {
          version: 1,
          hostPrepareMs: 10,
          cliSessionRestoreMs: 20,
          sessionRuntimeState: "cold",
        },
        rendererTiming: {
          rendererPrepareMs: 1,
          initialFrameTransportMs: 2,
          rendererSnapshotApplyMs: 3,
          snapshotAppliedAt: 4,
        },
        status: "live",
        lastError: null,
      }),
    );

    expect(calls[1]?.properties?.host_prepare_ms).toBeUndefined();
    expect(calls[1]?.properties?.renderer_prepare_ms).toBeUndefined();
    expect(calls[1]?.properties?.initial_frame_transport_ms).toBeUndefined();
  });

  it("does not reuse prior subscribe timing for a warm open", () => {
    const calls: Array<{
      name: string;
      properties?: Record<string, string | number | boolean | undefined>;
    }> = [];
    setSessionOpenArmsReporter({
      reportArmsCustomEvent: vi.fn(async (payload) => {
        calls.push({ name: payload.name, properties: payload.properties });
      }),
    });
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});

    renderHook(() =>
      useSessionOpenArmsTelemetry({
        sessionId: "session-warm",
        snapshot: snapshot("session-warm"),
        openKind: "warm",
        openTiming: {
          version: 1,
          hostPrepareMs: 10,
          cliSessionRestoreMs: 20,
          sessionRuntimeState: "cold",
        },
        rendererTiming: {
          rendererPrepareMs: 1,
          initialFrameTransportMs: 2,
          rendererSnapshotApplyMs: 3,
          snapshotAppliedAt: 4,
        },
        status: "live",
        lastError: null,
      }),
    );

    expect(calls[1]?.properties?.host_prepare_ms).toBeUndefined();
    expect(calls[1]?.properties?.cli_session_restore_ms).toBeUndefined();
    expect(calls[1]?.properties?.renderer_prepare_ms).toBeUndefined();
    expect(calls[1]?.properties?.initial_frame_transport_ms).toBeUndefined();
    expect(calls[1]?.properties?.react_render_ms).toBeUndefined();
  });

  it("reports a reconnect failure instead of succeeding from a residual snapshot", () => {
    const calls: Array<{ name: string; properties?: Record<string, unknown> }> = [];
    setSessionOpenArmsReporter({
      reportArmsCustomEvent: vi.fn(async (payload) => {
        calls.push({ name: payload.name, properties: payload.properties });
      }),
    });
    vi.useFakeTimers();
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(
      (callback) => setTimeout(() => callback(0), 1) as unknown as number,
    );
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((frame) => {
      clearTimeout(frame);
    });

    const { rerender } = renderHook(
      (props: { status: "connecting" | "live" | "error" | "closed"; lastError: string | null }) =>
        useSessionOpenArmsTelemetry({
          sessionId: "session-reconnecting",
          snapshot: snapshot("session-reconnecting"),
          openKind: "keep_warm",
          status: props.status,
          lastError: props.lastError,
        }),
      { initialProps: { status: "connecting", lastError: null } },
    );

    act(() => {
      vi.advanceTimersByTime(2);
      rerender({ status: "error", lastError: "fault.subscription.test" });
    });

    expect(calls.map((call) => call.name)).toEqual([
      "perf_ui_session_open_start",
      "perf_ui_session_open_result",
    ]);
    expect(calls[1]?.properties?.status).toBe("failed");
  });

  it("finishes a residual-snapshot open when the store becomes live", () => {
    const calls: Array<{ name: string; properties?: Record<string, unknown> }> = [];
    setSessionOpenArmsReporter({
      reportArmsCustomEvent: vi.fn(async (payload) => {
        calls.push({ name: payload.name, properties: payload.properties });
      }),
    });
    vi.useFakeTimers();
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(
      (callback) => setTimeout(() => callback(0), 1) as unknown as number,
    );
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((frame) => {
      clearTimeout(frame);
    });
    const residualSnapshot = snapshot("session-reconnecting-live");

    const { rerender } = renderHook(
      (props: { status: "connecting" | "live" | "error" | "closed" }) =>
        useSessionOpenArmsTelemetry({
          sessionId: "session-reconnecting-live",
          snapshot: residualSnapshot,
          openKind: "keep_warm",
          status: props.status,
          lastError: null,
        }),
      { initialProps: { status: "connecting" } },
    );

    act(() => {
      rerender({ status: "live" });
    });
    act(() => vi.runAllTimers());

    expect(calls.map((call) => call.name)).toEqual([
      "perf_ui_session_open_start",
      "perf_ui_session_open_result",
    ]);
    expect(calls[1]?.properties?.status).toBe("success");
  });
});
