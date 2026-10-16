import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("grouped draft task row style", () => {
  it("keeps the compact project label visible while hover actions appear", () => {
    const source = readFileSync(
      "packages/ui/src/workspace-grouped-tasks/draft-task-row.tsx",
      "utf8",
    );

    expect(source).toContain(
      "max-w-24 truncate rounded-full bg-tag/50 px-1.5 py-0.5 text-ui-sm text-foreground-subtle",
    );
    expect(source).not.toContain(
      'text-ui-sm text-foreground-subtle",\n              onClose && "group-hover/task-row:hidden"',
    );
    expect(source).toContain('<span className="relative size-6 shrink-0">');
    expect(source).toContain(
      "absolute inset-0 hidden items-center justify-center group-hover/task-row:flex",
    );
  });
});
