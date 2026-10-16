import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Plugin Store try mention commit", () => {
  it("keeps the hidden Settings workspace from consuming the one-shot prefill", () => {
    const shell = readFileSync(
      "packages/ui/src/app-shell/WorkspaceShellLayout.tsx",
      "utf8",
    );
    const workbench = readFileSync("packages/ui/src/v4/V4WorkspaceChatArea.tsx", "utf8");

    expect(shell).toContain("foregroundEnabled={isWorkspaceVisible}");
    expect(workbench).toContain("foregroundEnabled?: boolean");
    expect(workbench).toContain("focused={foregroundEnabled && focusedPaneId === leaf.paneId}");
  });
});
