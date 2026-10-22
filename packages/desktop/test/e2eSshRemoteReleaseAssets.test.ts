import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { ensureSshRemoteReleaseAssets } from "./e2e/helpers/e2e-ssh-remote-release-assets.js";

const RELEASE_DIR = "/repo/packages/desktop/mock-cdn/releases/3.12.0";
// 与 stage:remote-assets（remoteAssetRelease.ts collectSourceServerRemoteReleaseArchives）
// 的实际产物一致：descriptor 最后原子写入，四个 archive 按 target 命名。
const RELEASE_FILES = [
  "source-server-release.json",
  "zcode-server-linux-x64.tar.gz",
  "zcode-server-linux-arm64.tar.gz",
  "zcode-server-darwin-x64.tar.gz",
  "zcode-server-darwin-arm64.tar.gz",
];

function createFakeExists(existing: Set<string>) {
  // join 的分隔符随平台变化，fake exists 统一归一化成 posix 形式保证跨 OS 稳定。
  return vi.fn((path: string) => existing.has(path.split("\\").join("/")));
}

describe("ensureSshRemoteReleaseAssets", () => {
  it("skips prepare when the descriptor and all four target archives exist", () => {
    const prepareReleaseAssets = vi.fn();
    const exists = createFakeExists(new Set(RELEASE_FILES.map((name) => `${RELEASE_DIR}/${name}`)));

    const prepared = ensureSshRemoteReleaseAssets({
      exists,
      prepareReleaseAssets,
      releaseDir: RELEASE_DIR,
    });

    expect(prepared).toBe(false);
    expect(prepareReleaseAssets).not.toHaveBeenCalled();
  });

  it("does not treat legacy manifest-<platform>.json files as a complete release", () => {
    // Bug 根因：分支把 remote release 切换成 descriptor+archive 布局并删掉了
    // scripts/prepare-prebuilds.mjs，但 staging 合入的 helper 仍以四份 manifest 为完成态哨兵，
    // 新布局永远判“不完整”；旧布局残留目录也不能再被当成可用 release。
    const existing = new Set(
      ["linux-arm64", "linux-x64", "darwin-arm64", "darwin-x64"].map(
        (platform) => `${RELEASE_DIR}/manifest-${platform}.json`,
      ),
    );
    const exists = createFakeExists(existing);
    const prepareReleaseAssets = vi.fn(() => {
      for (const name of RELEASE_FILES) existing.add(`${RELEASE_DIR}/${name}`);
    });

    const prepared = ensureSshRemoteReleaseAssets({
      exists,
      prepareReleaseAssets,
      releaseDir: RELEASE_DIR,
    });

    expect(prepared).toBe(true);
    expect(prepareReleaseAssets).toHaveBeenCalledOnce();
  });

  it("re-prepares when the release dir exists but the descriptor is missing", () => {
    // 复查回归（issueId Q-a2867155a0ed0492e7f5）：目录存在性判幂等时，prepare 中途取消
    // 残留的半成品目录会永久跳过自愈。beginSourceServerRemoteReleaseGeneration 在开始时
    // 删除 descriptor、collect 全部完成后才重新写入，因此 descriptor 缺失即为不完整。
    const existing = new Set(
      RELEASE_FILES.filter((name) => name !== "source-server-release.json").map(
        (name) => `${RELEASE_DIR}/${name}`,
      ),
    );
    const exists = createFakeExists(existing);
    const prepareReleaseAssets = vi.fn(() => {
      existing.add(`${RELEASE_DIR}/source-server-release.json`);
    });

    const prepared = ensureSshRemoteReleaseAssets({
      exists,
      prepareReleaseAssets,
      releaseDir: RELEASE_DIR,
    });

    expect(prepared).toBe(true);
    expect(prepareReleaseAssets).toHaveBeenCalledOnce();
  });

  it("runs prepare when the release dir is missing and the assets appear afterwards", () => {
    const exists = vi.fn(() => false);
    const prepareReleaseAssets = vi.fn(() => {
      exists.mockReturnValue(true);
    });

    const prepared = ensureSshRemoteReleaseAssets({
      exists,
      prepareReleaseAssets,
      releaseDir: RELEASE_DIR,
    });

    expect(prepared).toBe(true);
    expect(prepareReleaseAssets).toHaveBeenCalledOnce();
  });

  it("stays fail-closed and names the missing archives when prepare does not complete", () => {
    const prepareReleaseAssets = vi.fn();
    const existing = new Set([
      `${RELEASE_DIR}/source-server-release.json`,
      `${RELEASE_DIR}/zcode-server-linux-x64.tar.gz`,
    ]);

    expect(() =>
      ensureSshRemoteReleaseAssets({
        exists: createFakeExists(existing),
        prepareReleaseAssets,
        releaseDir: RELEASE_DIR,
      }),
    ).toThrow(
      /prepare:remote-assets.*\/releases\/3\.12\.0.*zcode-server-linux-arm64\.tar\.gz, zcode-server-darwin-x64\.tar\.gz, zcode-server-darwin-arm64\.tar\.gz/u,
    );
    expect(prepareReleaseAssets).toHaveBeenCalledOnce();
  });
});

describe("wdio.conf.ts SSH remote assets wiring", () => {
  it("auto-prepares missing remote release assets via the root prepare:remote-assets script", () => {
    const source = readFileSync(new URL("../wdio.conf.ts", import.meta.url), "utf8");
    const stageDesktopE2EAppOutput = source.slice(
      source.indexOf("async function stageDesktopE2EAppOutput()"),
      source.indexOf("function isRendererE2EStoreBridgeCompiled"),
    );

    // Bug 根因：版本 bump 后专用 e2e runner 的工作区 mock-cdn 必然缺新版本 release，
    // 直接 fatal 会把每次版本升级都变成 CI-only 失败；必须先自动 prepare 再 fail-closed。
    expect(stageDesktopE2EAppOutput).toContain("ensureSshRemoteReleaseAssets(");
    expect(stageDesktopE2EAppOutput).not.toContain("SSH remote assets missing");
    // Bug 根因：packages/desktop 的 prepare:remote-assets 脚本已随 legacy asset pipeline 删除，
    // `pnpm --filter @zcode/desktop prepare:remote-assets` 会以 ERR_PNPM_RECURSIVE_RUN_NO_SCRIPT
    // 失败并让 onPrepare fatal；唯一有效入口是根 package.json 的 prepare:remote-assets。
    expect(stageDesktopE2EAppOutput).toMatch(
      /runPnpmWorkspaceCommand\(\["prepare:remote-assets"\]/u,
    );
    expect(stageDesktopE2EAppOutput).not.toMatch(/@zcode\/desktop",\s*"prepare:remote-assets/u);
    // prepare 调用点必须带 timeoutMs：CI 上下载/构建挂死时让 onPrepare 可失败退出，
    // 而不是占住专用 runner 直到 job 全局超时。（本片段内仅 prepare 一处 pnpm 调用。）
    expect(stageDesktopE2EAppOutput).toContain("timeoutMs: ");
  });
});
