import { describe, expect, it } from "vitest";
import { delimiter, dirname } from "node:path";

import { withPinnedNodePath } from "../../../scripts/mise-toolchain-env.mjs";

describe("mise toolchain child environment", () => {
  it("puts the launcher Node directory first without duplicating it", () => {
    const nodeDirectory = dirname(process.execPath);
    const originalPath = ["/opt/homebrew/bin", nodeDirectory, "/usr/bin", nodeDirectory].join(
      delimiter,
    );

    const result = withPinnedNodePath({ PATH: originalPath, KEEP_ME: "yes" }, process.execPath);

    expect(result.PATH?.split(delimiter)).toEqual([nodeDirectory, "/opt/homebrew/bin", "/usr/bin"]);
    expect(result.KEEP_ME).toBe("yes");
    expect(originalPath).toBe(
      ["/opt/homebrew/bin", nodeDirectory, "/usr/bin", nodeDirectory].join(delimiter),
    );
  });

  it("preserves Windows Path casing so pnpm.cmd remains discoverable", () => {
    const nodeDirectory = dirname(process.execPath);
    const originalPath = ["C:/tools/pnpm", nodeDirectory, "C:/Windows/System32"].join(delimiter);

    const result = withPinnedNodePath({ Path: originalPath, KEEP_ME: "yes" }, process.execPath);

    // 修复原因：Windows 盘符包含 `:`，用 macOS/Linux 宿主分隔符拆分会先破坏模拟的 Windows 路径。
    expect(result.Path).toBe(
      [nodeDirectory, "C:/tools/pnpm", "C:/Windows/System32"].join(delimiter),
    );
    expect(result.PATH).toBeUndefined();
  });
});
