import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function readAppSource(): string {
  return readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
}

function getQuickPickCommandsMemoBlock(source: string): string {
  const start = source.indexOf("const quickPickCommands = useMemo");
  const end = source.indexOf("  );", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("App quick pick command render stability", () => {
  it("does not recreate quick pick commands when only the user object reference changes", () => {
    const memoBlock = getQuickPickCommandsMemoBlock(readAppSource());

    // 性能回归保护：commands 会一路传给 CommandCenterDialog。
    // 这里只需要登录态布尔值，不应订阅完整 user 对象引用。
    expect(memoBlock).toContain("isLoggedIn");
    expect(memoBlock).not.toMatch(/\n\s+user,\n/);
  });

  it("memoizes task find dialog props before passing them to the shell layout", () => {
    const source = readAppSource();

    // 性能回归保护：taskFindDialogProps 是对象 prop，内联创建会让 WorkspaceShellLayout
    // 在无关流式刷新中看到新引用并继续向下重渲染。
    expect(source).toContain("const taskFindDialogProps = useMemo<TaskFindDialogProps>");
    expect(source).toContain("taskFindDialogProps={taskFindDialogProps}");
  });
});
