import { describe, expect, it } from "vitest";
import {
  normalizeRemoteArch,
  normalizeRemotePlatform,
  resolveRemotePlatform,
} from "../src/remote/detectEnv.js";

describe("remote detect env", () => {
  it("x86_64 / amd64 应归一化为 x64", () => {
    expect(normalizeRemoteArch("x86_64")).toBe("x64");
    expect(normalizeRemoteArch("amd64")).toBe("x64");
  });

  it("aarch64 / arm64e 应归一化为 arm64", () => {
    expect(normalizeRemoteArch("aarch64")).toBe("arm64");
    expect(normalizeRemoteArch("arm64e")).toBe("arm64");
  });

  it("darwin + linux 内核探针时应回退到 linux", () => {
    expect(resolveRemotePlatform("darwin", "linux")).toBe("linux");
  });

  it("真实 darwin 场景（无 /proc 内核值）不应回退", () => {
    expect(resolveRemotePlatform("darwin", "")).toBe("darwin");
  });

  it("platform 别名应归一化", () => {
    expect(normalizeRemotePlatform("GNU/Linux")).toBe("linux");
    expect(normalizeRemotePlatform("Windows_NT")).toBe("win32");
  });
});
