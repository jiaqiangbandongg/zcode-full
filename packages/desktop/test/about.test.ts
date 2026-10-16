import { describe, expect, it } from "vitest";
import {
  createAboutSnapshot,
  createSystemAboutPanelOptions,
  formatAboutCopyright,
  formatAboutDetail,
  formatAboutOptimizationLine,
} from "../src/main/about.js";
import { createCustomAboutDialogHtml } from "../src/main/aboutWindow.js";

describe("about", () => {
  const appleSiliconSnapshot = createAboutSnapshot({
    appVersion: "0.1.7",
    environment: "production",
    buildMetadata: {
      appVersion: "0.1.7",
      buildCommitId: "abc1234",
      buildTime: "2026-03-28T10:20:30.000Z",
      electronBuilderVersion: "26.8.1",
    },
    runtimeVersions: {
      electron: "41.0.3",
      chrome: "141.0.7390.122",
      node: "24.0.0",
      v8: "14.1.146.11-electron.0",
    },
    osInfo: {
      type: "Darwin",
      platform: "darwin",
      release: "25.0.0",
      version: "Darwin Kernel Version 25.0.0",
      arch: "arm64",
      hostname: "zcode-mbp",
    },
  });

  it("应格式化完整的 about 文本信息", () => {
    const detail = formatAboutDetail(appleSiliconSnapshot);

    expect(detail).toContain("Version: 0.1.7");
    expect(detail).toContain("Commit: abc1234");
    expect(detail).toContain("Build Time: 2026-03-28T10:20:30.000Z");
    expect(detail).toContain("Electron: 41.0.3");
    expect(detail).toContain("Electron Builder: 26.8.1");
    expect(detail).toContain("Chromium: 141.0.7390.122");
    expect(detail).toContain("Node.js: 24.0.0");
    expect(detail).toContain("V8: 14.1.146.11-electron.0");
    expect(detail).toContain("OS Platform: darwin");
    expect(detail).toContain("OS Arch: arm64");
    expect(detail).toContain("Hostname: zcode-mbp");
  });

  it("应生成接近系统 About 面板的 macOS 展示信息", () => {
    const options = createSystemAboutPanelOptions(appleSiliconSnapshot, 2026, "en-US");

    expect(options).toMatchObject({
      applicationName: "ZCode Desktop App",
      applicationVersion: "version 0.1.7",
      copyright: "Copyright © 2026 ZCode.",
      credits: "Optimized for Apple Silicon.",
    });
  });

  it("应按中文语言生成系统 About 面板信息", () => {
    const options = createSystemAboutPanelOptions(appleSiliconSnapshot, 2026, "zh-CN");

    expect(options).toMatchObject({
      applicationName: "ZCode Desktop App",
      applicationVersion: "版本 0.1.7",
      copyright: "版权所有 © 2026 ZCode。",
      credits: "已针对 Apple Silicon 优化。",
    });
  });

  it("应生成参考图样式的自定义 About 内容", () => {
    const html = createCustomAboutDialogHtml({
      applicationName: "ZCode Desktop App",
      appVersion: appleSiliconSnapshot.appVersion,
      copyright: "Copyright © 2026 ZCode.",
      optimizationLine: "Optimized for Apple Silicon.",
      versionLabel: "version",
      okButtonLabel: "OK",
    });

    expect(html).toContain("ZCode Desktop App");
    expect(html).toContain("version 0.1.7");
    expect(html).toContain("Optimized for Apple Silicon.");
    expect(html).toContain("Copyright © 2026 ZCode.");
    expect(html).toContain("class=\"ok-button\"");
    expect(html).toContain(">OK</button>");
    expect(html).toContain("class=\"app-logo\"");
    expect(html).toContain("viewBox=\"0 0 256 218\"");
    expect(html).toContain("linear-gradient(180deg, #000000 0%, #151718 100%)");
    expect(html).toContain("class=\"about-window\"");
    expect(html).toContain("border-radius: 0");
    expect(html).toContain("background: var(--about-primary)");
    expect(html).toContain("color: var(--about-primary-foreground)");
    expect(html).toContain("font-weight: 400");
    expect(html).toContain("--startup-page-bg: #171717");
    expect(html).not.toContain("<animate");
    expect(html).not.toContain("box-shadow: 0 28px 70px");
  });

  it("应生成中文自定义 About 内容", () => {
    const html = createCustomAboutDialogHtml({
      applicationName: "ZCode Desktop App",
      appVersion: appleSiliconSnapshot.appVersion,
      copyright: "版权所有 © 2026 ZCode。",
      optimizationLine: "已针对 Apple Silicon 优化。",
      versionLabel: "版本",
      okButtonLabel: "确定",
    });

    expect(html).toContain("版本 0.1.7");
    expect(html).toContain("已针对 Apple Silicon 优化。");
    expect(html).toContain("版权所有 © 2026 ZCode。");
    expect(html).toContain(">确定</button>");
  });

  it("非 Apple Silicon 不展示 Apple Silicon 优化文案", () => {
    expect(formatAboutOptimizationLine({ osPlatform: "darwin", osArch: "x64" }, "en-US")).toBe("");
    expect(formatAboutOptimizationLine({ osPlatform: "win32", osArch: "arm64" }, "en-US")).toBe("");
  });

  it("版权年份可按调用方传入覆盖", () => {
    expect(formatAboutCopyright(2027, "en-US")).toBe("Copyright © 2027 ZCode.");
    expect(formatAboutCopyright(2027, "zh-CN")).toBe("版权所有 © 2027 ZCode。");
  });
});
