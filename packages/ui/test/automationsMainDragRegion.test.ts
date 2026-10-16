import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function readSource(path: string) {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("workspace main view drag region", () => {
  it("keeps a desktop-only drag strip when automations or plugins hide WorkspaceHeader", () => {
    const layoutSource = readSource(
      "packages/ui/src/app-shell/WorkspaceShellLayout.tsx",
    );
    const frameSource = readSource(
      "packages/ui/src/settings/AutomationsMainBreadcrumbFrame.tsx",
    );

    // 断言语义不绑定排版：条件可被格式化换行。
    expect(layoutSource).toMatch(
      /workspaceMainView !== "automations"\s*&&\s*workspaceMainView !== "plugin-store"/,
    );
    expect(frameSource).toContain('data-testid="automations-main-drag-region"');
    expect(frameSource).toContain("h-12 shrink-0 [app-region:drag]");
    expect(frameSource).toContain("isDesktop ? (");
    expect(layoutSource).toContain(
      "min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]",
    );

    expect(
      layoutSource.match(/<AutomationsMainBreadcrumbFrame/gu)?.length,
    ).toBe(4);
    expect(
      frameSource.match(/data-testid="automations-main-drag-region"/gu)?.length,
    ).toBe(1);
  });

  it("reserves scrollbar space in automations and plugins shell layouts", () => {
    const layoutSource = readSource(
      "packages/ui/src/app-shell/WorkspaceShellLayout.tsx",
    );

    const stableScrollerCount =
      layoutSource.match(
        /min-h-0 flex-1 overflow-y-auto \[scrollbar-gutter:stable\]/gu,
      )?.length ?? 0;

    expect(stableScrollerCount).toBe(4);
  });
});
