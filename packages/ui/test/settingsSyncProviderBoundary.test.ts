import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Settings Sync Provider 事实源边界", () => {
  it("未实现 Provider 导入时不读取或刷新旧 Provider Snapshot", async () => {
    const source = await readFile(
      new URL("../src/hooks/useSettingsSync.ts", import.meta.url),
      "utf8",
    );

    expect(source).not.toContain("modelProviderService");
    expect(source).not.toContain("modelProviderSnapshot");
  });
});
