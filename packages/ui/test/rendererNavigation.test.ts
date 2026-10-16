import { describe, expect, it } from "vitest";
import { isRendererReloadNavigation } from "@/lib/rendererNavigation.js";

describe("renderer navigation kind", () => {
  it("only treats an actual renderer reload as reload recovery", () => {
    expect(isRendererReloadNavigation([{ type: "reload" }])).toBe(true);
    expect(isRendererReloadNavigation([{ type: "navigate" }])).toBe(false);
    expect(isRendererReloadNavigation([])).toBe(false);
  });
});
