import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function readSource(path: string) {
  return readFileSync(path, "utf8");
}

describe("WorkspaceShellLayout render stability source guards", () => {
  it("memoizes scoped error boundary reset key arrays", () => {
    const source = readSource("packages/ui/src/app-shell/WorkspaceShellLayout.tsx");

    expect(source).toContain("workspaceOnlyResetKeys = useMemo");
    expect(source).toContain("workspaceDraftResetKeys = useMemo");
    expect(source).toContain("workspaceSidebarVisibilityResetKeys = useMemo");
    expect(source).not.toContain("resetKeys={[workspaceKey]");
  });
});
