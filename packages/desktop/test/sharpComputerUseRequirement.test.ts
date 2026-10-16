import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { isSharpRequiredByComputerUse } from "../scripts/sharp-package-assets.mjs";

const roots: string[] = [];

function createWorkspace(cuaManifest: Record<string, unknown> | null, location: "root" | "desktop") {
  const root = mkdtempSync(join(tmpdir(), "zcode-sharp-cua-"));
  roots.push(root);
  const desktopRoot = join(root, "packages", "desktop");
  mkdirSync(desktopRoot, { recursive: true });
  if (cuaManifest) {
    const base = location === "root" ? root : desktopRoot;
    const cuaDir = join(base, "node_modules", "@zcode", "zcode-cua");
    mkdirSync(cuaDir, { recursive: true });
    writeFileSync(join(cuaDir, "package.json"), JSON.stringify(cuaManifest));
  }
  return desktopRoot;
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("isSharpRequiredByComputerUse", () => {
  it("真实 Computer Use 包声明 sharp 时需要暂存 sharp", () => {
    const desktopRoot = createWorkspace(
      { name: "@zcode/zcode-cua", dependencies: { sharp: "^0.34.0" } },
      "root",
    );
    expect(isSharpRequiredByComputerUse({ desktopPackageRoot: desktopRoot })).toBe(true);
  });

  it("不声明 sharp 的占位包不需要 sharp，优先读取离桌面包最近的安装", () => {
    const desktopRoot = createWorkspace({ name: "@zcode/zcode-cua", version: "0.6.3" }, "desktop");
    expect(isSharpRequiredByComputerUse({ desktopPackageRoot: desktopRoot })).toBe(false);
  });

  it("找不到 Computer Use 包时不需要 sharp", () => {
    const desktopRoot = createWorkspace(null, "root");
    expect(isSharpRequiredByComputerUse({ desktopPackageRoot: desktopRoot })).toBe(false);
  });
});
