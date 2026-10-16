import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { ensureSshRemoteReleaseAssets } from "./e2e/helpers/e2e-ssh-remote-release-assets.js";

describe("ensureSshRemoteReleaseAssets", () => {
  it("skips prepare when all four platform manifests exist", () => {
    const prepareReleaseAssets = vi.fn();
    const exists = vi.fn(() => true);

    const prepared = ensureSshRemoteReleaseAssets({
      exists,
      prepareReleaseAssets,
      releaseDir: "/repo/packages/desktop/mock-cdn/releases/3.12.0",
    });

    expect(prepared).toBe(false);
    expect(prepareReleaseAssets).not.toHaveBeenCalled();
  });

  it("re-prepares when the release dir exists but manifests are incomplete", () => {
    // 复查回归（issueId Q-a2867155a0ed0492e7f5）：目录存在性判幂等时，prepare 中途取消
    // 残留的半成品目录会永久跳过自愈；必须按 manifest 哨兵判完成态，不完整就重跑。
    const releaseDir = "/repo/packages/desktop/mock-cdn/releases/3.12.0";
    const existing = new Set([releaseDir]);
    // join 的分隔符随平台变化，fake exists 统一归一化成 posix 形式保证跨 OS 稳定。
    const exists = vi.fn((path: string) => existing.has(path.split("\\").join("/")));
    const prepareReleaseAssets = vi.fn(() => {
      for (const platform of ["linux-arm64", "linux-x64", "darwin-arm64", "darwin-x64"]) {
        existing.add(`${releaseDir}/manifest-${platform}.json`);
      }
    });

    const prepared = ensureSshRemoteReleaseAssets({
      exists,
      prepareReleaseAssets,
      releaseDir,
    });

    expect(prepared).toBe(true);
    expect(prepareReleaseAssets).toHaveBeenCalledOnce();
  });

  it("runs prepare when the release dir is missing and the manifests appear afterwards", () => {
    const exists = vi.fn(() => false);
    const prepareReleaseAssets = vi.fn(() => {
      // prepare 完成后 manifest 齐全
      exists.mockReturnValue(true);
    });

    const prepared = ensureSshRemoteReleaseAssets({
      exists,
      prepareReleaseAssets,
      releaseDir: "/repo/packages/desktop/mock-cdn/releases/3.12.0",
    });

    expect(prepared).toBe(true);
    expect(prepareReleaseAssets).toHaveBeenCalledOnce();
  });

  it("stays fail-closed when prepare does not complete the manifests", () => {
    const prepareReleaseAssets = vi.fn();

    expect(() =>
      ensureSshRemoteReleaseAssets({
        exists: () => false,
        prepareReleaseAssets,
        releaseDir: "/repo/packages/desktop/mock-cdn/releases/3.12.0",
      }),
    ).toThrow(/prepare:remote-assets.*\/releases\/3\.12\.0/u);
  });
});

describe("wdio.conf.ts SSH remote assets wiring", () => {
  it("auto-prepares missing remote release assets instead of failing onPrepare directly", () => {
    const source = readFileSync(new URL("../wdio.conf.ts", import.meta.url), "utf8");
    const stageDesktopE2EAppOutput = source.slice(
      source.indexOf("async function stageDesktopE2EAppOutput()"),
      source.indexOf("function isRendererE2EStoreBridgeCompiled"),
    );

    // Bug 根因：版本 bump 后专用 e2e runner 的工作区 mock-cdn 必然缺新版本 release，
    // 直接 fatal 会把每次版本升级都变成 CI-only 失败；必须先自动 prepare 再 fail-closed。
    expect(stageDesktopE2EAppOutput).toContain("ensureSshRemoteReleaseAssets(");
    expect(stageDesktopE2EAppOutput).toContain("prepare:remote-assets");
    expect(stageDesktopE2EAppOutput).not.toContain("SSH remote assets missing");
    // prepare 调用点必须带 timeoutMs：CI 上下载/构建挂死时让 onPrepare 可失败退出，
    // 而不是占住专用 runner 直到 job 全局超时。（本片段内仅 prepare 一处 pnpm 调用。）
    expect(stageDesktopE2EAppOutput).toMatch(
      /runPnpmWorkspaceCommand\(\[[^)]*prepare:remote-assets/u,
    );
    expect(stageDesktopE2EAppOutput).toContain("timeoutMs: ");
  });
});
