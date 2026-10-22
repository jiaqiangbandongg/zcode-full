import { describe, expect, it } from "vitest";
import { getZCodeToolFamilyForName } from "@zcode/shared";
import { resolveToolCallIdentity } from "@/lib/toolIdentity.js";
import { getWebFetchPrimaryText } from "@/ToolCallBlocks/renderers/web-fetch.js";

describe("WebFetch presentation", () => {
  it("separates fetching from searching", () => {
    expect(getZCodeToolFamilyForName("WebFetch")).toBe("web-fetch");
    for (const kind of ["fetch", "web_fetch", "webfetch"]) {
      expect(resolveToolCallIdentity({ kind }).family).toBe("web-fetch");
      expect(resolveToolCallIdentity({ toolName: kind, kind: "other" }).family).toBe("web-fetch");
    }
    for (const kind of ["WebSearch", "Grep", "Glob"]) {
      expect(resolveToolCallIdentity({ kind }).family).toBe("search");
    }
  });
  it("shows only a URL and tolerates incomplete streaming input", () => {
    expect(
      getWebFetchPrimaryText({ url: " https://example.com/paper ", prompt: "extract details" }),
    ).toBe("https://example.com/paper");
    expect(getWebFetchPrimaryText({ prompt: "extract details" })).toBe("");
    expect(getWebFetchPrimaryText(undefined)).toBe("");
  });
});
