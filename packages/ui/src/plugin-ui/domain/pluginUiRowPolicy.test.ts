import { describe, expect, it } from "vitest";
import type { ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import { deriveLogicalUiInstances } from "./pluginUiInstancePolicy.js";
import { isPluginUiPinnedToolRow } from "./pluginUiRowPolicy.js";

function row(id: number, status: ToolCallRow["status"] = "success", isError = false): ToolCallRow {
  return {
    kind: "toolCall",
    rowId: id,
    turnId: "turn",
    createdAt: id,
    createdAtSeq: id,
    toolCallId: `call-${id}`,
    toolName: "mcp__fixture__edit",
    status,
    inputText: "{}",
    display: {
      kind: "mcp_tool",
      serverName: "fixture",
      toolName: "edit",
      ui: {
        pluginId: "fixture",
        resourceUri: "ui://fixture",
        surface: "panel",
        preferredDisplayMode: "fullscreen",
        showInline: true,
        ...(isError ? { isError: true } : {}),
      },
    },
  };
}

describe("MCP App failure display eligibility", () => {
  it.each([row(1, "success", true), row(2, "error"), row(3, "cancelled")])(
    "failure $toolCallId cannot be pinned by a missing resolver, manual pin or auto-expand",
    (failed) => {
      expect(isPluginUiPinnedToolRow(failed)).toBe(false);
      const derivation = deriveLogicalUiInstances([failed]);
      expect(
        isPluginUiPinnedToolRow(failed, () => ({
          disposition: derivation.byToolCallId[failed.toolCallId],
          manualPinned: true,
        })),
      ).toBe(false);
    },
  );

  it("interleaved errors never displace the latest successful surface or add pinned app rows", () => {
    const rows = [
      row(1),
      row(2, "success", true),
      row(3),
      row(4, "success", true),
      row(5, "error"),
    ];
    const derivation = deriveLogicalUiInstances(rows);
    expect(derivation.instances).toHaveLength(1);
    expect(derivation.instances[0]?.activeToolCallId).toBe("call-3");
    expect(
      rows
        .filter((r) =>
          isPluginUiPinnedToolRow(r, (id) => ({
            disposition: derivation.byToolCallId[id],
            manualPinned: true,
          })),
        )
        .map((r) => r.toolCallId),
    ).toEqual(["call-3"]);
  });
});
