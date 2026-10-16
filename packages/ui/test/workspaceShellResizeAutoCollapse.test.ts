import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function readSource(path: string) {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("WorkspaceShellLayout resize auto-collapse", () => {
  it("waits for window resize idle before collapsing conversation panels", () => {
    const layoutSource = readSource("packages/ui/src/app-shell/WorkspaceShellLayout.tsx");

    expect(layoutSource).toContain("CONVERSATION_AUTO_COLLAPSE_RESIZE_IDLE_MS");
    expect(layoutSource).toContain("conversationAutoCollapseResizeTimerRef");
    expect(layoutSource).toMatch(/window\.setTimeout\(\s*\(\) => \{/u);
    expect(layoutSource).toMatch(/\},\s*CONVERSATION_AUTO_COLLAPSE_RESIZE_IDLE_MS,?\s*\);/u);
    expect(layoutSource).toContain(
      "window.clearTimeout(conversationAutoCollapseResizeTimerRef.current)",
    );
    expect(layoutSource).not.toContain("conversationAutoCollapseFrameRef");
  });
});
