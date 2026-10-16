import { describe, expect, it } from "vitest";
import { resolveSpawnRuntimeOptions } from "../../../scripts/spawn-command.mjs";

describe("spawn command runtime options", () => {
  it("Windows 下执行 pnpm 别名时也应显式走 shell，让 cmd 自己解析 shim", () => {
    expect(resolveSpawnRuntimeOptions("pnpm", "win32")).toEqual({ shell: true });
  });

  it("Windows 下执行 cmd 包装脚本时应显式走 shell", () => {
    expect(resolveSpawnRuntimeOptions("pnpm.cmd", "win32")).toEqual({ shell: true });
  });

  it("非 Windows 平台不应强制为 cmd 包装脚本开启 shell", () => {
    expect(resolveSpawnRuntimeOptions("pnpm.cmd", "darwin")).toEqual({});
  });
});
