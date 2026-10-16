import { describe, expect, it } from "vitest";
import {
  SESSION_OPEN_ARMS_GROUP,
  SESSION_OPEN_EVENT_RESULT,
  SESSION_OPEN_EVENT_START,
  buildSessionOpenResultArmsPayload,
  buildSessionOpenStartArmsPayload,
} from "@/lib/sessionOpenArmsTelemetry.js";

describe("session open ARMS telemetry", () => {
  it("builds one low-cardinality start event", () => {
    expect(
      buildSessionOpenStartArmsPayload({
        sessionOpenId: "open-1",
        sessionId: "session-1",
        openTrigger: "sidebar",
        openKind: "cold",
        clientMode: "desktop-continuous",
      }),
    ).toEqual({
      name: SESSION_OPEN_EVENT_START,
      group: SESSION_OPEN_ARMS_GROUP,
      value: 1,
      properties: {
        session_open_id: "open-1",
        session_id: "session-1",
        open_trigger: "sidebar",
        open_kind: "cold",
        client_mode: "desktop-continuous",
      },
    });
  });

  it("builds one terminal result with rounded bounded timings", () => {
    expect(
      buildSessionOpenResultArmsPayload({
        sessionOpenId: "open-1",
        sessionId: "session-1",
        openTrigger: "sidebar",
        openKind: "cold",
        clientMode: "desktop-continuous",
        status: "success",
        totalMs: 1234.6,
        rendererPrepareMs: 12.2,
        hostPrepareMs: 34.8,
        providerRegistrySyncMs: 11.1,
        taskMetaReadMs: 12.2,
        cliRequestMs: 13.3,
        cliBootstrapMs: -1,
        cliSessionRestoreMs: 456.4,
        initialFrameEncodeMs: 14.4,
        initialFrameTransportMs: 8.1,
        rendererSnapshotApplyMs: 4.9,
        reactRenderMs: 22.7,
        paintToInteractiveMs: 15.3,
        cliProcessState: "spawned",
        sessionRuntimeState: "cold",
        attemptCount: 1,
        persistedMessageCount: 42,
        snapshotRowCount: 18,
        snapshotBytes: 8192,
        pluginCount: 3,
        skillCount: 5,
        mcpServerCount: 2,
        mcpPendingAtInteractive: true,
      }),
    ).toEqual({
      name: SESSION_OPEN_EVENT_RESULT,
      group: SESSION_OPEN_ARMS_GROUP,
      value: 1235,
      properties: {
        session_open_id: "open-1",
        session_id: "session-1",
        open_trigger: "sidebar",
        open_kind: "cold",
        client_mode: "desktop-continuous",
        status: "success",
        total_ms: 1235,
        renderer_prepare_ms: 12,
        host_prepare_ms: 35,
        provider_registry_sync_ms: 11,
        task_meta_read_ms: 12,
        cli_request_ms: 13,
        cli_session_restore_ms: 456,
        initial_frame_encode_ms: 14,
        initial_frame_transport_ms: 8,
        renderer_snapshot_apply_ms: 5,
        react_render_ms: 23,
        paint_to_interactive_ms: 15,
        cli_process_state: "spawned",
        session_runtime_state: "cold",
        attempt_count: 1,
        persisted_message_count: 42,
        snapshot_row_count: 18,
        snapshot_bytes: 8192,
        plugin_count: 3,
        skill_count: 5,
        mcp_server_count: 2,
        mcp_pending_at_interactive: true,
      },
    });
  });
});
