import { describe, expect, it } from "vitest";
import {
  shouldHideZCodeSessionForkAction,
  supportsZCodeSessionFork,
} from "../src/lib/zcodeProviders.js";

describe("supportsZCodeSessionFork", () => {
  it("所有 provider 都开放 session fork 入口", () => {
    expect(supportsZCodeSessionFork("glm")).toBe(true);
    expect(supportsZCodeSessionFork("claude")).toBe(true);
    expect(supportsZCodeSessionFork("codex")).toBe(true);
    expect(supportsZCodeSessionFork("gemini")).toBe(true);
    expect(supportsZCodeSessionFork("opencode")).toBe(true);
  });
});

describe("shouldHideZCodeSessionForkAction", () => {
  it("所有 provider 都不再隐藏 fork UI 入口", () => {
    expect(shouldHideZCodeSessionForkAction("glm")).toBe(false);
    expect(shouldHideZCodeSessionForkAction("claude")).toBe(false);
    expect(shouldHideZCodeSessionForkAction("codex")).toBe(false);
    expect(shouldHideZCodeSessionForkAction("gemini")).toBe(false);
    expect(shouldHideZCodeSessionForkAction("opencode")).toBe(false);
  });
});
