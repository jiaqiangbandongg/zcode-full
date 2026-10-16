import { describe, expect, it } from "vitest";
import { resolveWorkspaceHeaderProvider } from "@/lib/workspaceHeaderProvider.js";

describe("resolveWorkspaceHeaderProvider", () => {
  it("优先返回当前 task 的 provider", () => {
    expect(resolveWorkspaceHeaderProvider("claude", "codex")).toBe("claude");
  });

  it("当没有 active task 时回退 workspace selected provider", () => {
    expect(resolveWorkspaceHeaderProvider(null, "codex")).toBe("codex");
  });
});
