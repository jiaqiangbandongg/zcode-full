import { describe, expect, it } from "vitest";
import {
  mobilePluginDiscoveryTelemetrySchema,
  resolveSafeTelemetryHostname,
  sanitizeTelemetrySkillName,
  sanitizeTelemetryEventDetail,
} from "../src/telemetry.js";

describe("resolveSafeTelemetryHostname", () => {
  it("只从 HTTP(S) URL 提取小写 hostname", () => {
    expect(
      resolveSafeTelemetryHostname("https://user:secret@API.Example.COM:8443/private?q=jwt"),
    ).toBe("api.example.com");
    expect(resolveSafeTelemetryHostname("http://127.0.0.1:64411")).toBe("127.0.0.1");
  });

  it.each(["", "api.example.com", "file:///private/path", "not a url"])(
    "拒绝非 URL 或非 HTTP(S) 值：%s",
    (value) => {
      expect(resolveSafeTelemetryHostname(value)).toBe("");
    },
  );
});

describe("Skill 遥测名称隐私边界", () => {
  it.each(["pptx", "control-browser", "demo_skill", "a".repeat(64)])("保留合法标识 %s", (name) => {
    expect(sanitizeTelemetrySkillName(name)).toBe(name);
  });
  it.each([
    "/Users/FAKE_USER/private",
    "C:\\private\\key",
    "https://example.com/?token=FAKE",
    "demo\nFAKE_SECRET",
    " demo",
    "demo ",
    "document-skills:pptx",
    "user@example.com",
    "sk-" + "a".repeat(49),
    "ghp_" + "a".repeat(36),
    "AKIA" + "A".repeat(16),
    "a".repeat(65),
    "a".repeat(5000),
    "",
    123,
    null,
  ])("拒绝不受控名称 %#", (name) => {
    expect(sanitizeTelemetrySkillName(name)).toBe("unknown");
    if (typeof name === "string") {
      const detail = { tool_name: "Skill", skill_name: name };
      const safe = sanitizeTelemetryEventDetail("agent_step", detail);
      expect(safe.skill_name).toBe("unknown");
      expect(detail.skill_name).toBe(name);
      expect(sanitizeTelemetryEventDetail("agent_step", safe)).toEqual(safe);
    }
  });
});

describe("plugin telemetry privacy", () => {
  it("drops arbitrary input and preserves only bounded plugin dimensions", () => {
    expect(
      sanitizeTelemetryEventDetail("plugin_lifecycle", {
        action: "install",
        result: "success",
        plugin_id: "demo@market",
        schema_version: "1",
        options: "secret",
        token: "secret",
        workspacePath: "/private",
        operation_id: "extra",
        source_type: "https://private",
        duration_ms: "12",
      }),
    ).toEqual({
      action: "install",
      result: "success",
      plugin_id: "demo@market",
      schema_version: "1",
      duration_ms: "12",
    });
  });
  it("rejects obsolete started results and path-like identifiers", () => {
    expect(
      sanitizeTelemetryEventDetail("plugin_lifecycle", {
        result: "started",
        plugin_id: "/private/demo",
        marketplace: "https://private",
      }),
    ).toEqual({});
  });
});

describe("mobile plugin discovery schema", () => {
  const event = {
    elementName: "plugin_discovery",
    eventRegion: "app",
    eventType: "view",
    context: { clientTimezone: "UTC", clientLanguage: "en-US", screenResolution: "1x1" },
    eventExtraDetail: {
      schema_version: "1",
      action: "detail_view",
      entry: "store_detail",
      client_kind: "mobile",
      plugin_id: "a@market",
    },
  };
  it("only admits discovery with bounded fields", () => {
    expect(mobilePluginDiscoveryTelemetrySchema.safeParse(event).success).toBe(true);
    expect(
      mobilePluginDiscoveryTelemetrySchema.safeParse({ ...event, elementName: "agent_step" })
        .success,
    ).toBe(false);
    expect(
      mobilePluginDiscoveryTelemetrySchema.safeParse({
        ...event,
        eventExtraDetail: { ...event.eventExtraDetail, token: "secret" },
      }).success,
    ).toBe(false);
  });
});

it("rejects private plugin attribution on existing agent steps", () => {
  expect(
    sanitizeTelemetryEventDetail("agent_step", {
      plugin_id: "/private/plugin",
      plugin_component: "mcp",
      status: "success",
    }),
  ).toEqual({ plugin_component: "mcp", status: "success" });
});
