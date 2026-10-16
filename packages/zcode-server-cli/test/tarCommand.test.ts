import { describe, expect, it, vi } from "vitest";
import { isTarCommand, resolveHostTarCommand } from "../src/packaging/tarCommand.js";

function stubPlatform(platform: NodeJS.Platform) {
  vi.spyOn(process, "platform", "get").mockReturnValue(platform);
}

describe("resolveHostTarCommand", () => {
  it("非 Windows 宿主原样返回 PATH 解析的 tar，不触碰 System32（CR 复审回归）", () => {
    stubPlatform("linux");
    // 曾在平台判断前无条件解析 System32/tar.exe，POSIX 归档会直接抛错。
    expect(resolveHostTarCommand()).toBe("tar");
    stubPlatform("darwin");
    expect(resolveHostTarCommand()).toBe("tar");
  });

  it("Windows 宿主缺失 System32 tar.exe 时 fail-fast，不回退 PATH", () => {
    stubPlatform("win32");
    const original = process.env.SystemRoot;
    process.env.SystemRoot = "Z:\\definitely-missing";
    try {
      expect(() => resolveHostTarCommand()).toThrow(/System32 tar\.exe missing/u);
    } finally {
      process.env.SystemRoot = original;
    }
  });

  it("isTarCommand 同时命中裸 tar 与 System32 绝对路径形态", () => {
    expect(isTarCommand("tar")).toBe(true);
    expect(isTarCommand("C:\\Windows\\System32\\tar.exe")).toBe(true);
    expect(isTarCommand("/usr/bin/tar")).toBe(true);
    expect(isTarCommand("zip")).toBe(false);
  });
});
