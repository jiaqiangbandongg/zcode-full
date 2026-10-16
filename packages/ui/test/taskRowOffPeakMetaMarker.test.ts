// D48 MR1：月亮标识从 off-peak store 反查切换为持久 meta 判断（isOffPeakTask）。
// 行为不变（图标/位置一致），数据源变化用源码断言锁定，防止回退到 store 订阅。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function readSource(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), "utf8");
}

describe("off-peak 月亮标识走持久 meta 标记", () => {
  for (const relativePath of [
    "packages/ui/src/workspace-grouped-tasks/task-row.tsx",
    "packages/ui/src/TaskListItem.tsx",
  ]) {
    it(`${relativePath} 使用 isOffPeakTask 且不再反查 off-peak store`, () => {
      const source = readSource(relativePath);
      expect(source).toContain("isOffPeakTask(task)");
      expect(source).not.toContain("offPeakTask.sessionId === task.taskId");
      // 图标本体与可达性标签保持不变。
      expect(source).toContain("data-off-peak-task-icon");
      expect(source).toContain("taskList.offPeakTaskLabel");
    });
  }
});
