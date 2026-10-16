import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function readSource(path: string) {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

function readCallbackBody(source: string, callbackName: string) {
  const marker = `const ${callbackName} = useCallback(`;
  const markerIndex = source.indexOf(marker);
  expect(markerIndex).toBeGreaterThanOrEqual(0);
  const nextCallbackMatch = /\n\s+const \w+ = useCallback\(/u.exec(
    source.slice(markerIndex + marker.length),
  );
  const nextCallbackIndex = nextCallbackMatch
    ? markerIndex + marker.length + nextCallbackMatch.index
    : source.length;
  return source.slice(markerIndex, nextCallbackIndex);
}

describe("WorkspaceShellLayout sidebar resize performance", () => {
  it("keeps drag-time sidebar width updates outside React state", () => {
    const layoutSource = readSource("packages/ui/src/app-shell/WorkspaceShellLayout.tsx");
    const resizeMoveBody = readCallbackBody(layoutSource, "handleWorkspaceSidebarResizeMove");

    expect(layoutSource).toContain("applyWorkspaceSidebarWidthDuringDrag");
    expect(resizeMoveBody).toContain("applyWorkspaceSidebarWidthDuringDrag(nextWidthPx)");
    expect(resizeMoveBody).not.toContain("setWorkspaceSidebarPanelWidthPx");
  });

  it("marks active sidebar resizing through DOM attributes instead of React state", () => {
    const layoutSource = readSource("packages/ui/src/app-shell/WorkspaceShellLayout.tsx");
    const resizeStartBody = readCallbackBody(layoutSource, "handleWorkspaceSidebarResizeStart");
    const resizeFinishBody = readCallbackBody(layoutSource, "finishWorkspaceSidebarResize");

    expect(layoutSource).toContain("setWorkspaceSidebarResizeActive");
    expect(layoutSource).toContain("data-workspace-shell");
    expect(layoutSource).toContain("data-[workspace-sidebar-resizing=true]:transition-opacity");
    expect(resizeStartBody).toContain("setWorkspaceSidebarResizeActive({");
    expect(resizeStartBody).toContain("active: true");
    expect(resizeFinishBody).toContain("setWorkspaceSidebarResizeActive({");
    expect(resizeFinishBody).toContain("active: false");
    expect(layoutSource).not.toContain("isWorkspaceSidebarResizing");
    expect(layoutSource).not.toContain("setIsWorkspaceSidebarResizing");
  });

  // M3 竖切：ChatView 滚动 hook 已删；sidebar drag 跳过 scroll layout 的 v4 等价实现归 M5 分屏期。
  it.skip("lets chat scroll code skip layout metrics during sidebar drag", () => {
    const scrollSource = readSource("packages/ui/src/ChatView/useChatConversationScroll.ts");
    const resizeStateSource = readSource("packages/ui/src/lib/workspaceSidebarResizeState.ts");

    expect(scrollSource).toContain("isWorkspaceSidebarResizeActiveForElement");
    expect(scrollSource).toContain("WORKSPACE_SIDEBAR_RESIZE_END_EVENT");
    expect(scrollSource).toContain("addEventListener");
    expect(resizeStateSource).toContain("WORKSPACE_SIDEBAR_RESIZE_END_EVENT");
    expect(resizeStateSource).toContain("dispatchEvent");
    expect(scrollSource).toContain("return;");
    expect(scrollSource).toContain("workspace sidebar resize");
  });
});
