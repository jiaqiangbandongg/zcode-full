import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function readSource(path: string): string {
  return readFileSync(path, "utf8");
}

describe("settings resource form containers", () => {
  it.each([
    {
      path: "packages/ui/src/settings/SubagentsSection.tsx",
      rootClass: "space-y-3 rounded-xl border border-border p-4",
    },
    {
      path: "packages/ui/src/settings/McpServerForm.tsx",
      rootClass: "space-y-4 rounded-xl border border-border p-4",
    },
    {
      path: "packages/ui/src/settings/CommandForm.tsx",
      rootClass: "space-y-3 rounded-xl border border-border p-4",
    },
  ])("renders $path with a transparent card boundary", ({ path, rootClass }) => {
    const source = readSource(path);

    expect(source).toContain(rootClass);
    expect(source).not.toContain(rootClass.replace("border-border", "border-border bg-card"));
    // 表单操作区统一走共享 SettingsFormActions（自带 pt-1 间距）。
    expect(source).toContain("<SettingsFormActions");
    expect(source).toContain("<SettingsFormTextarea");
  });

  it("keeps the Hook runner Select aligned with large form controls", () => {
    const source = readSource("packages/ui/src/settings/HookForm.tsx");

    // 断言语义不绑定排版：属性可被 JSX 格式化换行。
    expect(source).toMatch(
      /<SelectTrigger[^>]*id="hook-runner"[^>]*size="lg"[^>]*className="w-full md:w-48"/s,
    );
    expect(source).not.toContain(
      "inline-flex h-8 w-fit rounded-lg border border-input-border bg-input p-0.5",
    );
  });
});
