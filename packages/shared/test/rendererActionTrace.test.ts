import { describe, expect, it } from "vitest";
import {
  rendererActionTraceBatchSchema,
  rendererActionTraceConfigSchema,
} from "../src/rendererActionTrace.js";

describe("renderer action trace transport", () => {
  it("accepts bounded production config and rejects an unsafe ratio", () => {
    expect(
      rendererActionTraceConfigSchema.safeParse({
        enabled: true,
        sampleRatio: 0.05,
        enabledGroups: ["core", "settings"],
        configVersion: "v1",
      }).success,
    ).toBe(true);
    expect(
      rendererActionTraceConfigSchema.safeParse({
        enabled: true,
        sampleRatio: 0.5,
        enabledGroups: ["core"],
        configVersion: "v1",
      }).success,
    ).toBe(false);
  });

  it("rejects arbitrary attributes and sensitive fields", () => {
    const result = rendererActionTraceBatchSchema.safeParse({
      version: 1,
      rendererInstanceId: "renderer-1",
      sequence: 1,
      droppedSinceLastFlush: 0,
      spans: [
        {
          traceId: "1".repeat(32),
          spanId: "2".repeat(16),
          name: "ui_action",
          startTimeUnixMs: 1,
          endTimeUnixMs: 2,
          status: "ok",
          attributes: {
            feature_id: "settings.memory",
            action: "toggle_memory",
            catalog_group: "settings",
            operation_kind: "preference",
            surface: "settings.memory",
            trigger: "switch",
            outcome: "completed",
            result_source: "shared_settings",
            action_id: "action-1",
            workspacePath: "/secret",
          },
        },
      ],
    });
    expect(result.success).toBe(false);
  });
});
