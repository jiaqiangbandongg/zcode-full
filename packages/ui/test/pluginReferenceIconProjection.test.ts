import type { ZCodePluginReferenceCatalogEntry } from "@zcode/shared";
import { describe, expect, it } from "vitest";
import {
  buildSessionPluginIconMap,
  hasPluginReferenceUserRows,
  isSessionPluginCatalogReady,
} from "@/v4/pluginReferenceIconProjection.js";

function plugin(pluginId: string, icon?: string): ZCodePluginReferenceCatalogEntry {
  const [name = pluginId, marketplace = "market"] = pluginId.split("@");
  return {
    pluginId,
    name,
    marketplace,
    ...(icon ? { icon } : {}),
    enabled: true,
    conflictingPluginIds: [],
    skillQualifiedNames: [],
    mcpServerNames: [],
    subagentNames: [],
  };
}

describe("Session Plugin icon projection", () => {
  it("waits for the matching cold-resumed snapshot before reading session authority", () => {
    expect(isSessionPluginCatalogReady("connecting", "session-a", "session-a")).toBe(false);
    expect(isSessionPluginCatalogReady("live", "session-a", null)).toBe(false);
    expect(isSessionPluginCatalogReady("live", "session-a", "session-b")).toBe(false);
    expect(isSessionPluginCatalogReady("live", "session-a", "session-a")).toBe(true);
    expect(isSessionPluginCatalogReady("live", null, null)).toBe(false);
  });

  it("indexes display-only icons by stable id only for Session authority", () => {
    const entries = [
      plugin("skill-creator@official", "https://plugins.example.test/pencil.png"),
      plugin("without-icon@official"),
    ];

    expect(buildSessionPluginIconMap("session", entries)).toEqual(
      new Map([["skill-creator@official", "https://plugins.example.test/pencil.png"]]),
    );
    expect(buildSessionPluginIconMap("workspace", entries)).toEqual(new Map());
    expect(buildSessionPluginIconMap(null, entries)).toEqual(new Map());
  });

  it("never derives identity from a display label", () => {
    const iconMap = buildSessionPluginIconMap("session", [
      plugin("skill-creator@official", "https://plugins.example.test/pencil.png"),
    ]);

    expect(iconMap.get("skill-creator@official")).toBe("https://plugins.example.test/pencil.png");
    expect(iconMap.get("skill-creator")).toBeUndefined();
  });

  it("only enables the expensive Session catalog projection when a user row references a Plugin", () => {
    expect(
      hasPluginReferenceUserRows([
        { kind: "assistantText", text: "plugin://demo@market" },
        { kind: "userInput", text: "普通消息" },
      ]),
    ).toBe(false);
    expect(
      hasPluginReferenceUserRows([
        { kind: "userInput", text: "使用 [@Demo](plugin://demo@market)" },
      ]),
    ).toBe(true);
  });
});
