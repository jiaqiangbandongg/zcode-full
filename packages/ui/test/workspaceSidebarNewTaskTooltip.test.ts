import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("workspace sidebar new task tooltip", () => {
  it("正常状态不显示重复提示，仅只读状态展示禁用原因", async () => {
    const source = await readFile(
      new URL("../src/WorkspaceSidebar.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain("if (!disabledReason) return children;");
    expect(source).toContain(
      "<WorkspaceNewTaskTooltip disabledReason={workspaceReadOnlyReason}>",
    );
    expect(source).not.toContain(
      'workspaceReadOnlyReason ??\n                intl.formatMessage({ id: "taskList.newThread" })',
    );
  });
});
