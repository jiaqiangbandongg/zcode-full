import { describe, expect, it } from "vitest";
import { cloudContentPayloadSchema } from "../src/cloudContent.js";

const payload = {
  schemaVersion: 1,
  id: "notice",
  revision: 1,
  kind: "feature",
  locale: "en-US",
  dialog: {
    title: "Title",
    description: { format: "html", text: "<b>Hello</b>" },
    hero: {
      type: "interactive_bundle",
      runtime: "zcode-hero-sandbox-v1",
      bundle: {
        format: "zip",
        url: "https://example.com/hero.zip",
        sha256: "a".repeat(64),
        sizeBytes: 100,
        entry: "index.html",
      },
      viewport: { aspectRatio: "4:3" },
      data: {},
      events: {},
    },
    buttons: [{ id: "close", label: "Close", variant: "primary", actionId: "close" }],
  },
  actions: { close: { type: "close" } },
};
describe("cloud content wire schema", () => {
  it("rejects malformed URLs without throwing outside safeParse", () => {
    const bad = structuredClone(payload);
    bad.dialog.hero.bundle.url = "https://";
    expect(cloudContentPayloadSchema.safeParse(bad).success).toBe(false);
  });
  it("accepts the complete ZIP/HTML payload", () => {
    expect(cloudContentPayloadSchema.parse(payload).dialog.title).toBe("Title");
  });
  it("rejects unsupported schema, malformed ZIP and dangling button references", () => {
    expect(cloudContentPayloadSchema.safeParse({ ...payload, schemaVersion: 2 }).success).toBe(
      false,
    );
    expect(cloudContentPayloadSchema.safeParse({ ...payload, actions: {} }).success).toBe(false);
    const bad = structuredClone(payload);
    bad.dialog.hero.bundle.sha256 = "bad";
    expect(cloudContentPayloadSchema.safeParse(bad).success).toBe(false);
  });
  it("rejects oversized content, duplicate buttons and unknown action types", () => {
    const bad = structuredClone(payload);
    bad.dialog.description.text = "x".repeat(20001);
    expect(cloudContentPayloadSchema.safeParse(bad).success).toBe(false);
    bad.dialog.description.text = "okay";
    bad.dialog.buttons.push(bad.dialog.buttons[0]!);
    expect(cloudContentPayloadSchema.safeParse(bad).success).toBe(false);
    expect(
      cloudContentPayloadSchema.safeParse({
        ...payload,
        actions: { close: { type: "execute_js" } },
      }).success,
    ).toBe(false);
  });
});
