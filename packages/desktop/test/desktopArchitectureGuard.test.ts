import { describe, expect, it } from "vitest";
import {
  detectArchitectureMismatch,
  formatArchitectureMismatchDialogText,
  resolveArchitectureDownloadUrl,
} from "../src/main/desktopArchitectureGuard.js";

describe("detectArchitectureMismatch", () => {
  it("Apple 芯片上运行 x64 包（Rosetta 转译）应判定为不匹配", () => {
    expect(
      detectArchitectureMismatch({
        platform: "darwin",
        binaryArch: "x64",
        runningUnderARM64Translation: true,
      }),
    ).toEqual({ binaryArch: "x64", nativeArch: "arm64" });
  });

  it("Windows on ARM 上转译运行也应判定为不匹配", () => {
    expect(
      detectArchitectureMismatch({
        platform: "win32",
        binaryArch: "x64",
        runningUnderARM64Translation: true,
      }),
    ).toEqual({ binaryArch: "x64", nativeArch: "arm64" });
  });

  it("原生运行（未转译）应返回 null", () => {
    expect(
      detectArchitectureMismatch({
        platform: "darwin",
        binaryArch: "arm64",
        runningUnderARM64Translation: false,
      }),
    ).toBeNull();
  });

  it("非 macOS/Windows 平台即使报告转译也不误报", () => {
    expect(
      detectArchitectureMismatch({
        platform: "linux",
        binaryArch: "x64",
        runningUnderARM64Translation: true,
      }),
    ).toBeNull();
  });
});

describe("resolveArchitectureDownloadUrl", () => {
  it("按语言分流到官网下载页", () => {
    expect(resolveArchitectureDownloadUrl("zh-CN")).toBe("https://zcode.z.ai/cn");
    expect(resolveArchitectureDownloadUrl("en-US")).toBe("https://zcode.z.ai/en");
  });
});

describe("formatArchitectureMismatchDialogText", () => {
  const mismatch = { binaryArch: "x64", nativeArch: "arm64" } as const;

  it("中文文案包含运行架构与推荐架构", () => {
    const text = formatArchitectureMismatchDialogText(mismatch, "zh-CN");
    expect(text.title).toBe("架构不匹配");
    expect(text.detail).toContain("x64");
    expect(text.detail).toContain("arm64");
    expect(text.downloadButton).toBe("前往下载");
  });

  it("英文文案包含运行架构与推荐架构", () => {
    const text = formatArchitectureMismatchDialogText(mismatch, "en-US");
    expect(text.title).toBe("Architecture Mismatch");
    expect(text.detail).toContain("x64");
    expect(text.detail).toContain("arm64");
    expect(text.downloadButton).toBe("Download");
  });
});
