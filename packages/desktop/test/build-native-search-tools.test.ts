import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MACOS_NATIVE_SEARCH_DEPLOYMENT_TARGET,
  LEGACY_REMOTE_RIPGREP_VERSION,
  LINUX_NATIVE_SEARCH_GLIBC_BASELINE,
  NATIVE_SEARCH_BFS_CONFIGURE_ARGS,
  NATIVE_SEARCH_OFFICIAL_RIPGREP_ASSETS,
  NATIVE_SEARCH_PREBUILT_RELEASES,
  NATIVE_SEARCH_PRODUCER_ARCHIVE_SHA256_BY_TARGET,
  NATIVE_SEARCH_RIPGREP_REVISION,
  NATIVE_SEARCH_SOURCE_ARCHIVES,
  NATIVE_SEARCH_TOOL_VERSIONS,
  getExpectedUgrepFeatureContract,
  getNativeSearchProducerOutputIds,
  getNativeSearchRuntimeToolIdsForPlatform,
  getNativeSearchSourceArchivesForTarget,
  resolveNativeSearchBuildPlan,
  resolveNativeSearchPrebuiltRelease,
  resolveNativeSearchPrebuiltDownloadBaseUrl,
  resolveNativeSearchPrebuiltPlan,
  resolveNativeSearchRipgrepDownloadBaseUrl,
  resolveNativeSearchReleasePlan,
} from "../../../scripts/native-search-tools-config.mjs";
import {
  assertLinuxNativeSearchBuildEnvironment,
  createBfsBuildEnvironment,
  resolveNativeUnixBuildConfig,
} from "../../../scripts/native-search-tools-unix.mjs";
import { resolveNativeWindowsBuildConfig } from "../../../scripts/native-search-tools-windows.mjs";
import {
  getAllowedLinuxNativeSearchDependencies,
  getRequiredGlibcVersions,
  verifyLinuxGlibcBaseline,
  verifyBuiltNativeSearchProducerOutputs,
  verifyBuiltNativeSearchTools,
  verifyMacosDeploymentTarget,
  verifyNativeSearchBinaryTarget,
} from "../../../scripts/native-search-tools-verify.mjs";
import { readWindowsPeMetadata } from "../../../scripts/native-search-tools-windows-pe.mjs";
import {
  packNativeSearchPrebuiltArtifacts,
  resolveNativeSearchPackagedArtifactPath,
} from "../../../scripts/package-native-search-tools.mjs";

const rootPackageJson = JSON.parse(
  readFileSync(join(import.meta.dirname, "../../../package.json"), "utf8"),
) as { scripts: Record<string, string> };
const windowsNativeSearchCmake = readFileSync(
  join(import.meta.dirname, "../../../scripts/native-search-tools-windows/CMakeLists.txt"),
  "utf8",
);


// 内网依赖源由环境显式配置；用中性主机，测试不依赖仓库默认的内网地址（开源导出里默认地址为空）。
const INTRANET_ENV = { INTRANET_MACHINE_HOST: "intranet-deps.example" };
const INTRANET_DEPS_BASE_URL = "http://intranet-deps.example:12345/zcode/deps";

describe("native search build", () => {
  it("通过简洁的 host-target producer 命令打包原生搜索工具", () => {
    expect(rootPackageJson.scripts["pack:native-search"]).toBe(
      "node scripts/package-native-search-tools.mjs",
    );
    expect(rootPackageJson.scripts).not.toHaveProperty("pack:native-search:linux:rocky8");
    expect(rootPackageJson.scripts["ci:ensure-native-search-deps"]).toBe(
      "node scripts/ensure-native-search-deps.mjs",
    );
    expect(rootPackageJson.scripts).not.toHaveProperty("package:native-search");
  });

  it("固定 native search 工具版本、生产源码与完整性摘要", () => {
    expect(NATIVE_SEARCH_TOOL_VERSIONS).toEqual({
      bfs: "4.1.1",
      ripgrep: "14.1.1",
      ugrep: "7.8.4",
    });
    expect(NATIVE_SEARCH_RIPGREP_REVISION).toBe("4649aa9700");
    expect(LEGACY_REMOTE_RIPGREP_VERSION).toBe("v13.0.0-10");
    expect(NATIVE_SEARCH_PREBUILT_RELEASES).toEqual({
      bfs: "v4.1.1-1",
      ripgrep: "v14.1.1-1",
      ugrep: "v7.8.4-1",
    });
    expect(LINUX_NATIVE_SEARCH_GLIBC_BASELINE).toBe("2.28");
    expect(resolveNativeSearchPrebuiltRelease("bfs", "linux")).toBe("v4.1.1-2");
    expect(resolveNativeSearchPrebuiltRelease("ugrep", "linux")).toBe("v7.8.4-1");
    expect(resolveNativeSearchPrebuiltRelease("bfs", "darwin")).toBe("v4.1.1-1");
    expect(resolveNativeSearchPrebuiltRelease("ugrep", "win32")).toBe("v7.8.4-1");
    expect(NATIVE_SEARCH_SOURCE_ARCHIVES.map(({ id, version }) => `${id}@${version}`)).toEqual([
      "bfs@4.1.1",
      "ugrep@7.8.4",
      "oniguruma@6.9.10",
      "pcre2@10.43",
      "zlib@1.3.1",
      "bzip2@1.0.8",
      "zstd@1.5.6",
      "brotli@1.1.0",
    ]);
    for (const source of NATIVE_SEARCH_SOURCE_ARCHIVES) {
      expect(source.url).toMatch(/^https:\/\//);
      expect(source.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(NATIVE_SEARCH_SOURCE_ARCHIVES.find(({ id }) => id === "ugrep")).toEqual({
      id: "ugrep",
      version: "7.8.4",
      url: "https://codeload.github.com/Genivia/ugrep/tar.gz/550599a6434fc5315fb6ecd415a5d859e6d846a8",
      sha256: "0b3ed2dc7c3902d89f2ef8b66961db2e31a32f240fa2a2e0eb8d559827f36dab",
    });
    expect(NATIVE_SEARCH_OFFICIAL_RIPGREP_ASSETS).toEqual({
      "darwin-arm64": {
        archiveExt: "tar.gz",
        releaseFileName: "ripgrep-v14.1.1-1-aarch64-apple-darwin.tar.gz",
        revision: NATIVE_SEARCH_RIPGREP_REVISION,
        sha256: "84ff9b227b9aad651be0ac4cf7802a190015bfba3dfa6b015cc7aa89dd8c5c2b",
      },
      "darwin-x64": {
        archiveExt: "tar.gz",
        releaseFileName: "ripgrep-v14.1.1-1-x86_64-apple-darwin.tar.gz",
        revision: NATIVE_SEARCH_RIPGREP_REVISION,
        sha256: "cfedd7993342bc5f90310ce73a00cbf5d3b5237654c9bfc18b383f0e829f3b11",
      },
      "linux-arm64": {
        archiveExt: "tar.gz",
        releaseFileName: "ripgrep-v14.1.1-1-aarch64-unknown-linux-musl.tar.gz",
        revision: null,
        sha256: "98c0371366a9db920ed6c196083e8030511055e5f128b3bde2ca56bbddf85b9a",
      },
      "linux-x64": {
        archiveExt: "tar.gz",
        releaseFileName: "ripgrep-v14.1.1-1-x86_64-unknown-linux-musl.tar.gz",
        revision: NATIVE_SEARCH_RIPGREP_REVISION,
        sha256: "1154dd91f7b144cee490b91f1ab27ce04f8f01d8876cde2d9c0eff845c8ab012",
      },
      "win32-x64": {
        archiveExt: "zip",
        releaseFileName: "ripgrep-v14.1.1-1-x86_64-pc-windows-msvc.zip",
        revision: NATIVE_SEARCH_RIPGREP_REVISION,
        sha256: "ede1d7f533f30d7e2870f77139d0fb9d7591daad5260b80d6a525e0bb5bd440e",
      },
      "win32-arm64": {
        archiveExt: "zip",
        releaseFileName: "ripgrep-v14.1.1-1-aarch64-pc-windows-msvc.zip",
        revision: NATIVE_SEARCH_RIPGREP_REVISION,
        sha256: "88660d96f822d2e0329e254031068e82028f9c13efcec9b2d78c5a19d3f9ac47",
      },
    });
    expect(NATIVE_SEARCH_PRODUCER_ARCHIVE_SHA256_BY_TARGET).toEqual({
      "darwin-arm64": {
        bfs: "696f73eaff50d3c3de8a8ee36746a89693dd6ff0d010b05cd3b4b3eb2a369781",
        ugrep: "01ea803e3fc3b94e796a9376e4d062a5490fe08e5760c6173e72b8f31546a4f3",
      },
      "darwin-x64": {
        bfs: "d993d72530749fa777339a7546f03338499abf235e2147d4adcd086641c6376f",
        ugrep: "6a2bedd9ccf53a2ac574d2fa498a36dcbe21e957b40442f9493180c6dad4dea9",
      },
      "linux-arm64": {
        bfs: "dabdde935a02f89dd0c48c5cd0ec756a87d300fd5ace85a78e6a9eb51d771118",
        ugrep: "bf3b99c0af41f50c0ec3031b32ab8f67fa95b5581add18fad5163ece978d31ba",
      },
      "linux-x64": {
        bfs: "9adf5759000021dd8fcd99670461cc43863f9172fb16f2f9a3e49c700311e7a0",
        ugrep: "13732f50fe63da07f3472f627f611b75359153163d07a0eb01e7c54125ae930e",
      },
      "win32-arm64": {
        ugrep: "e9de73f1b542105203d586b19b4d57b8ecf2bf780f23e86c66a0fb7f56d51024",
      },
      "win32-x64": {
        ugrep: "7bbd8e56540d2019a343688f1fc0ddb2ff5f0988090c577d2b9d6f4a8a86be21",
      },
    });
  });

  it("预编译资源按目标固定为 producer 或 Microsoft release", () => {
    const darwin = resolveNativeSearchPrebuiltPlan({
      platform: "darwin",
      arch: "arm64",
      env: INTRANET_ENV,
    });
    expect(darwin.artifacts.map(({ toolId, downloadUrl }) => [toolId, downloadUrl])).toEqual([
      [
        "bfs",
        `${INTRANET_DEPS_BASE_URL}/native-search-tools/bfs-v4.1.1-1/bfs-v4.1.1-1-aarch64-apple-darwin.tar.gz`,
      ],
      [
        "ugrep",
        `${INTRANET_DEPS_BASE_URL}/native-search-tools/ugrep-v7.8.4-1/ugrep-v7.8.4-1-aarch64-apple-darwin.tar.gz`,
      ],
      [
        "ripgrep",
        `${INTRANET_DEPS_BASE_URL}/native-search-tools/ripgrep-v14.1.1-1/ripgrep-v14.1.1-1-aarch64-apple-darwin.tar.gz`,
      ],
    ]);
    const linux = resolveNativeSearchPrebuiltPlan({ platform: "linux", arch: "x64", env: INTRANET_ENV });
    expect(
      linux.artifacts.map(({ toolId, releaseFileName, source }) => [
        toolId,
        releaseFileName,
        source,
      ]),
    ).toEqual([
      ["bfs", "bfs-v4.1.1-2-x86_64-unknown-linux-gnu.tar.gz", "producer"],
      ["ugrep", "ugrep-v7.8.4-1-x86_64-unknown-linux-gnu.tar.gz", "producer"],
      ["ripgrep", "ripgrep-v14.1.1-1-x86_64-unknown-linux-musl.tar.gz", "official"],
    ]);
    expect(linux.artifacts.slice(0, 2).map(({ downloadUrl }) => downloadUrl)).toEqual([
      `${INTRANET_DEPS_BASE_URL}/native-search-tools/bfs-v4.1.1-2/bfs-v4.1.1-2-x86_64-unknown-linux-gnu.tar.gz`,
      `${INTRANET_DEPS_BASE_URL}/native-search-tools/ugrep-v7.8.4-1/ugrep-v7.8.4-1-x86_64-unknown-linux-gnu.tar.gz`,
    ]);
    expect(linux.artifacts.slice(0, 2).map(({ archiveSha256 }) => archiveSha256)).toEqual([
      NATIVE_SEARCH_PRODUCER_ARCHIVE_SHA256_BY_TARGET["linux-x64"].bfs,
      NATIVE_SEARCH_PRODUCER_ARCHIVE_SHA256_BY_TARGET["linux-x64"].ugrep,
    ]);
    expect(linux.artifacts.at(-1)).toMatchObject({
      archiveSha256: NATIVE_SEARCH_OFFICIAL_RIPGREP_ASSETS["linux-x64"].sha256,
      downloadUrl:
        `${INTRANET_DEPS_BASE_URL}/native-search-tools/ripgrep-v14.1.1-1/ripgrep-v14.1.1-1-x86_64-unknown-linux-musl.tar.gz`,
    });
    const windows = resolveNativeSearchPrebuiltPlan({ platform: "win32", arch: "x64", env: INTRANET_ENV });
    expect(windows.artifacts).toMatchObject([
      {
        archiveExt: "zip",
        binaryName: "ugrep.exe",
        releaseFileName: "ugrep-v7.8.4-1-x86_64-pc-windows-msvc.zip",
        toolId: "ugrep",
      },
      {
        archiveExt: "zip",
        binaryName: "rg.exe",
        releaseFileName: "ripgrep-v14.1.1-1-x86_64-pc-windows-msvc.zip",
        source: "official",
        toolId: "ripgrep",
      },
    ]);
    expect(
      resolveNativeSearchPrebuiltPlan({ platform: "win32", arch: "arm64" }).artifacts,
    ).toMatchObject([
      {
        releaseFileName: "ugrep-v7.8.4-1-aarch64-pc-windows-msvc.zip",
        toolId: "ugrep",
      },
      {
        archiveSha256: NATIVE_SEARCH_OFFICIAL_RIPGREP_ASSETS["win32-arm64"].sha256,
        releaseFileName: "ripgrep-v14.1.1-1-aarch64-pc-windows-msvc.zip",
        source: "official",
        toolId: "ripgrep",
      },
    ]);
    for (const [platformKey, sha256ByTool] of Object.entries(
      NATIVE_SEARCH_PRODUCER_ARCHIVE_SHA256_BY_TARGET,
    )) {
      const [platform, arch] = platformKey.split("-") as [
        "darwin" | "linux" | "win32",
        "arm64" | "x64",
      ];
      const producerArtifacts = resolveNativeSearchPrebuiltPlan({
        platform,
        arch,
      }).artifacts.filter(({ source }) => source === "producer");
      for (const [toolId, archiveSha256] of Object.entries(sha256ByTool)) {
        expect(producerArtifacts.find((artifact) => artifact.toolId === toolId)).toMatchObject({
          archiveSha256,
        });
      }
    }
    for (const [platformKey, asset] of Object.entries(NATIVE_SEARCH_OFFICIAL_RIPGREP_ASSETS)) {
      const [platform, arch] = platformKey.split("-") as [
        "darwin" | "linux" | "win32",
        "arm64" | "x64",
      ];
      const ripgrepArtifact = resolveNativeSearchPrebuiltPlan({ platform, arch }).artifacts.find(
        ({ toolId }) => toolId === "ripgrep",
      );
      expect(ripgrepArtifact).toMatchObject({
        archiveSha256: asset.sha256,
        release: "v14.1.1-1",
        releaseFileName: asset.releaseFileName,
        source: "official",
      });
    }
  });

  it("预编译资源 base url 支持与既有 ripgrep 相同的显式覆盖", () => {
    expect(resolveNativeSearchRipgrepDownloadBaseUrl(INTRANET_ENV)).toBe(
      `${INTRANET_DEPS_BASE_URL}/native-search-tools/ripgrep-v14.1.1-1`,
    );
    expect(
      resolveNativeSearchPrebuiltDownloadBaseUrl({
        NATIVE_SEARCH_TOOLS_DOWNLOAD_BASE_URL: "https://example.test/native-search/",
      }),
    ).toBe("https://example.test/native-search");
    expect(
      resolveNativeSearchRipgrepDownloadBaseUrl({
        NATIVE_SEARCH_RIPGREP_DOWNLOAD_BASE_URL: "https://example.test/ripgrep/",
      }),
    ).toBe("https://example.test/ripgrep");
    expect(
      resolveNativeSearchRipgrepDownloadBaseUrl({
        ZCODE_DEPS_BASE_URL: "https://deps.example.test/zcode/deps/",
      }),
    ).toBe("https://deps.example.test/zcode/deps/native-search-tools/ripgrep-v14.1.1-1");
  });

  it("producer 按下载契约生成稳定的 tar.gz 与 Windows zip", async () => {
    const root = mkdtempSync(join(tmpdir(), "zcode-native-search-package-test-"));
    try {
      for (const [platform, arch] of [
        ["darwin", "arm64"],
        ["win32", "arm64"],
        ["win32", "x64"],
      ] as const) {
        const prebuiltPlan = resolveNativeSearchPrebuiltPlan({
          platform,
          arch,
          outputDir: join(root, "binaries", `${platform}-${arch}`),
        });
        const producerArtifacts = prebuiltPlan.artifacts.filter(
          ({ source }) => source === "producer",
        );
        for (const artifact of producerArtifacts) {
          mkdirSync(dirname(artifact.binaryPath), { recursive: true });
          writeFileSync(artifact.binaryPath, `${platform}-${arch}-${artifact.toolId}`);
          chmodSync(artifact.binaryPath, 0o755);
        }

        const firstOutput = join(root, "first");
        const secondOutput = join(root, "second");
        await packNativeSearchPrebuiltArtifacts({ prebuiltPlan, artifactsDir: firstOutput });
        await packNativeSearchPrebuiltArtifacts({ prebuiltPlan, artifactsDir: secondOutput });

        for (const artifact of producerArtifacts) {
          const relativeArchivePath = join(
            "native-search-tools",
            `${artifact.toolId}-${artifact.release}`,
            artifact.releaseFileName,
          );
          const digest = (base: string) =>
            createHash("sha256")
              .update(readFileSync(join(base, relativeArchivePath)))
              .digest("hex");
          expect(digest(firstOutput)).toBe(digest(secondOutput));
        }
        for (const artifact of prebuiltPlan.artifacts.filter(
          ({ source }) => source === "official",
        )) {
          expect(() =>
            readFileSync(
              join(
                firstOutput,
                "native-search-tools",
                `${artifact.toolId}-${artifact.release}`,
                artifact.releaseFileName,
              ),
            ),
          ).toThrow();
        }
      }
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("producer 可以生成候选归档，固定摘要由发布边界校验", async () => {
    const root = mkdtempSync(join(tmpdir(), "zcode-native-search-unpinned-release-test-"));
    try {
      const prebuiltPlan = resolveNativeSearchPrebuiltPlan({
        platform: "linux",
        arch: "x64",
        outputDir: join(root, "binaries"),
      });
      for (const artifact of prebuiltPlan.artifacts.filter(({ source }) => source === "producer")) {
        mkdirSync(dirname(artifact.binaryPath), { recursive: true });
        writeFileSync(artifact.binaryPath, `not-the-published-${artifact.toolId}`);
        chmodSync(artifact.binaryPath, 0o755);
      }

      const artifactsDir = join(root, "artifacts");
      await expect(
        packNativeSearchPrebuiltArtifacts({ prebuiltPlan, artifactsDir }),
      ).resolves.toBeUndefined();
      for (const artifact of prebuiltPlan.artifacts.filter(({ source }) => source === "producer")) {
        const archivePath = resolveNativeSearchPackagedArtifactPath({ artifact, artifactsDir });
        expect(readFileSync(archivePath).byteLength).toBeGreaterThan(0);
        expect(sha256(archivePath)).not.toBe(artifact.archiveSha256);
      }
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("Windows zip producer 在不同时区生成相同字节", () => {
    const root = mkdtempSync(join(tmpdir(), "zcode-native-search-zip-timezone-test-"));
    try {
      const prebuiltPlan = resolveNativeSearchPrebuiltPlan({
        platform: "win32",
        arch: "x64",
        outputDir: join(root, "binaries"),
      });
      const producerArtifacts = prebuiltPlan.artifacts.filter(
        ({ source }) => source === "producer",
      );
      for (const artifact of producerArtifacts) {
        mkdirSync(dirname(artifact.binaryPath), { recursive: true });
        writeFileSync(artifact.binaryPath, `win32-x64-${artifact.toolId}`);
      }

      const utcOutput = join(root, "utc");
      const shanghaiOutput = join(root, "shanghai");
      packageNativeSearchInTimezone(prebuiltPlan, utcOutput, "UTC");
      packageNativeSearchInTimezone(prebuiltPlan, shanghaiOutput, "Asia/Shanghai");

      for (const artifact of producerArtifacts) {
        const relativeArchivePath = join(
          "native-search-tools",
          `${artifact.toolId}-${artifact.release}`,
          artifact.releaseFileName,
        );
        expect(sha256(join(utcOutput, relativeArchivePath))).toBe(
          sha256(join(shanghaiOutput, relativeArchivePath)),
        );
      }
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("各目标只下载 producer 实际需要的锁定源码", () => {
    const versionsFor = (platform: "darwin" | "linux" | "win32", arch: "arm64" | "x64") =>
      Object.fromEntries(
        getNativeSearchSourceArchivesForTarget({ platform, arch })
          .filter(({ id }) => id in NATIVE_SEARCH_TOOL_VERSIONS)
          .map(({ id, version }) => [id, version]),
      );

    const unixProducerVersions = {
      bfs: NATIVE_SEARCH_TOOL_VERSIONS.bfs,
      ugrep: NATIVE_SEARCH_TOOL_VERSIONS.ugrep,
    };
    expect(versionsFor("darwin", "arm64")).toEqual(unixProducerVersions);
    expect(versionsFor("darwin", "x64")).toEqual(unixProducerVersions);
    expect(versionsFor("linux", "arm64")).toEqual(unixProducerVersions);
    expect(versionsFor("linux", "x64")).toEqual(unixProducerVersions);
    expect(versionsFor("win32", "arm64")).toEqual({
      ugrep: NATIVE_SEARCH_TOOL_VERSIONS.ugrep,
    });
    expect(versionsFor("win32", "x64")).toEqual({
      ugrep: NATIVE_SEARCH_TOOL_VERSIONS.ugrep,
    });
  });

  it("按编译平台分支固定 ugrep 的 PCRE2 feature contract", () => {
    expect(getExpectedUgrepFeatureContract("darwin")).toBe(
      "; -P:pcre2; -z:zlib,bzip2,zstd,brotli,7z,tar/pax/cpio/zip",
    );
    expect(getExpectedUgrepFeatureContract("linux")).toBe(
      "; -P:pcre2jit; -z:zlib,bzip2,zstd,brotli,7z,tar/pax/cpio/zip",
    );
    expect(getExpectedUgrepFeatureContract("win32")).toBe(
      "; -P:pcre2jit; -z:zlib,bzip2,zstd,brotli,7z,tar/pax/cpio/zip",
    );
  });

  it("区分最终 runtime 工具与各目标 producer 输出", () => {
    expect(getNativeSearchRuntimeToolIdsForPlatform("darwin")).toEqual(["bfs", "ugrep", "ripgrep"]);
    expect(getNativeSearchRuntimeToolIdsForPlatform("linux")).toEqual(["bfs", "ugrep", "ripgrep"]);
    expect(getNativeSearchRuntimeToolIdsForPlatform("win32")).toEqual(["ugrep", "ripgrep"]);
    for (const platform of ["darwin", "linux"] as const) {
      for (const arch of ["arm64", "x64"] as const) {
        expect(getNativeSearchProducerOutputIds({ platform, arch })).toEqual(["bfs", "ugrep"]);
      }
    }
    for (const arch of ["arm64", "x64"] as const) {
      expect(getNativeSearchProducerOutputIds({ platform: "win32", arch })).toEqual(["ugrep"]);
    }
  });

  it("只为已经完成 E2E 的 platform-arch 启用 desktop release", () => {
    expect(resolveNativeSearchReleasePlan({ platform: "darwin", arch: "arm64" })).toMatchObject({
      enabled: true,
      runtimeToolIds: ["bfs", "ugrep", "ripgrep"],
      extraResourceToolIds: ["bfs", "ugrep"],
    });
    expect(resolveNativeSearchReleasePlan({ platform: "darwin", arch: "x64" })).toMatchObject({
      enabled: true,
      runtimeToolIds: ["bfs", "ugrep", "ripgrep"],
      extraResourceToolIds: ["bfs", "ugrep"],
    });
    for (const arch of ["arm64", "x64"]) {
      expect(resolveNativeSearchReleasePlan({ platform: "linux", arch })).toMatchObject({
        enabled: true,
        runtimeToolIds: ["bfs", "ugrep", "ripgrep"],
        extraResourceToolIds: ["bfs", "ugrep"],
      });
    }
    for (const arch of ["arm64", "x64"] as const) {
      expect(resolveNativeSearchReleasePlan({ platform: "win32", arch })).toMatchObject({
        enabled: true,
        runtimeToolIds: ["ugrep", "ripgrep"],
        extraResourceToolIds: ["ugrep"],
      });
    }
  });

  it("source plan 不下载官方 rg 或目标不需要的 Unix-only 源码", () => {
    expect(
      getNativeSearchSourceArchivesForTarget({ platform: "darwin", arch: "arm64" }).map(
        ({ id }) => id,
      ),
    ).toEqual(["bfs", "ugrep", "oniguruma", "pcre2", "zlib", "bzip2", "zstd", "brotli"]);
    expect(
      getNativeSearchSourceArchivesForTarget({ platform: "win32", arch: "x64" }).map(
        ({ id }) => id,
      ),
    ).toEqual(["ugrep", "pcre2", "zlib", "bzip2", "zstd", "brotli"]);
    expect(
      getNativeSearchSourceArchivesForTarget({ platform: "win32", arch: "arm64" }).map(
        ({ id }) => id,
      ),
    ).toEqual(["ugrep", "pcre2", "zlib", "bzip2", "zstd", "brotli"]);
    for (const platform of ["darwin", "linux"] as const) {
      for (const arch of ["arm64", "x64"] as const) {
        expect(
          getNativeSearchSourceArchivesForTarget({ platform, arch }).map(({ id }) => id),
        ).not.toContain("ripgrep");
      }
    }
  });

  it.each([
    ["darwin", "arm64", "bfs", "bfs"],
    ["darwin", "x64", "ugrep", "ugrep"],
    ["linux", "arm64", "bfs", "bfs"],
    ["linux", "x64", "ugrep", "ugrep"],
    ["darwin", "arm64", "ripgrep", "rg"],
    ["linux", "x64", "ripgrep", "rg"],
    ["win32", "arm64", "ugrep", "ugrep.exe"],
    ["win32", "arm64", "ripgrep", "rg.exe"],
    ["win32", "x64", "ugrep", "ugrep.exe"],
    ["win32", "x64", "ripgrep", "rg.exe"],
  ] as const)("为 %s-%s 生成 %s sidecar 路径", (platform, arch, toolId, binaryName) => {
    const outputDir = join(tmpdir(), `zcode-native-search-${platform}-${arch}`);
    const plan = resolveNativeSearchBuildPlan({ platform, arch, outputDir });

    expect(plan.platformKey).toBe(`${platform}-${arch}`);
    expect(plan.binaries[toolId]).toBe(join(outputDir, toolId, binaryName));
    expect(plan.bfsPath).toBe(platform === "win32" ? undefined : join(outputDir, "bfs", "bfs"));
  });

  it("为 Darwin 和 Linux 提供各自的平台构建 flags", () => {
    const darwin = resolveNativeUnixBuildConfig({
      platform: "darwin",
      arch: "arm64",
      hostPlatform: "darwin",
      hostArch: "arm64",
      env: {},
    });
    expect(darwin.cc).toBe("clang");
    expect(darwin.cxx).toBe("clang++");
    expect(darwin.brotliOsDefine).toBe("OS_MACOSX");
    expect(darwin.bfsCppFlags).toEqual([
      "-Dposix_spawn_file_actions_addfchdir=__bfs_poison_addfchdir_macos_26_0",
      "-Dfdclosedir=__bfs_poison_fdclosedir_macos_26_4",
    ]);
    expect(NATIVE_SEARCH_BFS_CONFIGURE_ARGS).toEqual([
      "--enable-release",
      "--with-oniguruma",
      "--without-libselinux",
      "--without-libacl",
      "--without-liburing",
      "--without-libcap",
    ]);
    expect(darwin.pcre2ConfigureArgs).toEqual(["--disable-jit"]);
    expect(darwin.targetCompilerArgs).toEqual(["-arch", "arm64"]);
    expect(darwin.ugrepLdFlags).toEqual(["-Wl,-x"]);
    expect(darwin.usesRosettaCrossBuild).toBe(false);
    expect(darwin.cargoTargetTriple).toBeUndefined();
    expect(darwin.macosDeploymentTarget).toBe(MACOS_NATIVE_SEARCH_DEPLOYMENT_TARGET);

    const darwinX64 = resolveNativeUnixBuildConfig({
      platform: "darwin",
      arch: "x64",
      hostPlatform: "darwin",
      hostArch: "arm64",
      env: {},
    });
    expect(darwinX64.targetCompilerArgs).toEqual(["-arch", "x86_64"]);
    expect(darwinX64.ugrepConfigureArgs).toEqual(["--host=x86_64-apple-darwin", "--disable-avx2"]);
    expect(darwinX64.usesRosettaCrossBuild).toBe(true);
    expect(darwinX64.cargoTargetTriple).toBeUndefined();
    expect(darwinX64.macosDeploymentTarget).toBe(MACOS_NATIVE_SEARCH_DEPLOYMENT_TARGET);

    const linux = resolveNativeUnixBuildConfig({
      platform: "linux",
      arch: "x64",
      hostPlatform: "linux",
      hostArch: "x64",
      env: {},
    });
    expect(linux.cc).toBe("gcc");
    expect(linux.cxx).toBe("g++");
    expect(linux.brotliOsDefine).toBe("OS_LINUX");
    expect(linux.bfsCppFlags).toEqual([]);
    expect(linux.pcre2ConfigureArgs).toEqual(["--enable-jit", "--with-pic"]);
    expect(linux.ugrepConfigureArgs).toEqual(["--disable-avx2"]);
    expect(linux.ugrepLdFlags).toEqual(["-Wl,-x", "-static-libgcc", "-static-libstdc++"]);
    expect(linux.macosDeploymentTarget).toBeUndefined();
  });

  it("bfs 构建 flags 不记录随机临时目录", () => {
    const sourcePath = "/tmp/zcode-native-search-build-random/sources/bfs";
    const prefix = "/tmp/zcode-native-search-build-random/prefix";
    const config = resolveNativeUnixBuildConfig({
      platform: "darwin",
      arch: "arm64",
      hostPlatform: "darwin",
      hostArch: "arm64",
      env: {},
    });
    const env = createBfsBuildEnvironment({ sourcePath, prefix, env: {}, config });

    // Bugfix：createBfsBuildEnvironment 用宿主 path.relative 算出 prefix 的相对路径，
    // Windows 上是 `..\..\prefix\include`，而这里原来写死 POSIX 字面量，两条断言在
    // Windows 上都对不上。用宿主 join 组装期望片段，断言仍然表达同一个「相对 prefix 布局」。
    expect(env.EXTRA_CPPFLAGS).toContain(`-I${join("../../prefix/include")}`);
    expect(env.EXTRA_LDFLAGS).toBe(`-L${join("../../prefix/lib")}`);
    expect(env.EXTRA_LDLIBS).toBe("-lonig");
    expect(env.PKG_CONFIG).toBe("true");
    expect(env.VERSION).toBe("4.1.1");
    expect(Object.values(env).join(" ")).not.toContain("zcode-native-search-build-random");
  });

  it("Linux verifier 应拒绝 bfs/ugrep 动态依赖 C++ runtime", () => {
    const forbiddenCppDependencies = [
      "libc++.so.1",
      "libc++abi.so.1",
      "libgcc_s.so.1",
      "libstdc++.so.6",
    ];

    for (const arch of ["x64", "arm64"] as const) {
      const bfsDependencies = getAllowedLinuxNativeSearchDependencies("bfs", arch);
      const ugrepDependencies = getAllowedLinuxNativeSearchDependencies("ugrep", arch);
      for (const dependency of forbiddenCppDependencies) {
        expect(bfsDependencies).not.toContain(dependency);
        expect(ugrepDependencies).not.toContain(dependency);
      }
      expect(getAllowedLinuxNativeSearchDependencies("ripgrep", arch)).toEqual([]);
    }

    expect(getAllowedLinuxNativeSearchDependencies("bfs", "x64")).toContain("ld-linux-x86-64.so.2");
    expect(getAllowedLinuxNativeSearchDependencies("bfs", "arm64")).toContain(
      "ld-linux-aarch64.so.1",
    );
  });

  it("Linux producer 按实际 Node、glibc、CC 与 CXX 能力放行", () => {
    expect(() =>
      assertLinuxNativeSearchBuildEnvironment({
        nodeVersion: "24.14.0",
        glibcVersion: "2.28",
        gccVersion: "12.2.1",
        cxxVersion: "12.2.1",
      }),
    ).not.toThrow();
    expect(() =>
      assertLinuxNativeSearchBuildEnvironment({
        nodeVersion: "22.16.0",
        glibcVersion: "2.28",
        gccVersion: "12.2.1",
        cxxVersion: "12.2.1",
      }),
    ).toThrow("Node 24");
    expect(() =>
      assertLinuxNativeSearchBuildEnvironment({
        nodeVersion: "24.14.0",
        glibcVersion: "2.36",
        gccVersion: "12.2.1",
        cxxVersion: "12.2.1",
      }),
    ).toThrow("glibc 2.28");
    expect(() =>
      assertLinuxNativeSearchBuildEnvironment({
        nodeVersion: "24.14.0",
        glibcVersion: "2.28",
        gccVersion: "8.5.0",
        cxxVersion: "12.2.1",
      }),
    ).toThrow("GCC 12");
    expect(() =>
      assertLinuxNativeSearchBuildEnvironment({
        nodeVersion: "24.14.0",
        glibcVersion: "2.28",
        gccVersion: "12.2.1",
        cxxVersion: "13.2.1",
      }),
    ).toThrow("G++ 12");
  });

  it("Linux ABI gate 接受 GLIBC_2.28 ceiling 并拒绝更高 symbol version", () => {
    const versionInfo = [
      "  0x0010: Name: GLIBC_2.2.5  Flags: none  Version: 5",
      "  0x0020: Name: GLIBC_2.17  Flags: none  Version: 4",
      "  0x0030: Name: GLIBC_2.28  Flags: none  Version: 3",
      "  0x0040: Name: GLIBCXX_3.4.21  Flags: none  Version: 2",
    ].join("\n");

    expect(getRequiredGlibcVersions(versionInfo)).toEqual(["2.2.5", "2.17", "2.28"]);
    expect(() => verifyLinuxGlibcBaseline(versionInfo, "bfs")).not.toThrow();
    expect(() => verifyLinuxGlibcBaseline(`${versionInfo}\nName: GLIBC_2.29`, "ugrep")).toThrow(
      "GLIBC_2.29",
    );
    expect(() => verifyLinuxGlibcBaseline("Version symbols section", "bfs")).toThrow(
      "missing GLIBC symbol versions",
    );
  });

  it("macOS verifier 接受更低 deployment target 且拒绝提高系统下限", () => {
    expect(() =>
      verifyMacosDeploymentTarget("cmd LC_BUILD_VERSION\n  minos 11.0\n", "rg-arm64", {
        allowLowerDeploymentTarget: true,
      }),
    ).not.toThrow();
    expect(() =>
      verifyMacosDeploymentTarget(
        "cmd LC_VERSION_MIN_MACOSX\ncmdsize 16\nversion 10.12\nsdk 15.5\n",
        "rg-x64",
        { allowLowerDeploymentTarget: true },
      ),
    ).not.toThrow();
    expect(() =>
      verifyMacosDeploymentTarget("cmd LC_BUILD_VERSION\n  minos 12.0\n", "bfs"),
    ).not.toThrow();
    expect(() =>
      verifyMacosDeploymentTarget("cmd LC_BUILD_VERSION\n  minos 11.0\n", "lower-bfs"),
    ).toThrow("expected target is 12.0");
    expect(() =>
      verifyMacosDeploymentTarget("cmd LC_BUILD_VERSION\n  minos 13.0\n", "future-rg", {
        allowLowerDeploymentTarget: true,
      }),
    ).toThrow("maximum supported target is 12.0");
  });

  it("拒绝 Windows Unix build 和未经验证的 Unix 跨架构构建", () => {
    expect(() =>
      resolveNativeUnixBuildConfig({
        platform: "win32",
        arch: "x64",
        hostPlatform: "win32",
        hostArch: "x64",
      }),
    ).toThrow("does not support platform win32");

    expect(() =>
      resolveNativeUnixBuildConfig({
        platform: "darwin",
        arch: "arm64",
        hostPlatform: "darwin",
        hostArch: "x64",
      }),
    ).toThrow("must run natively for darwin-arm64");
  });

  it("Windows producer 复用 MSVC/CMake 支持 x64 与 ARM64 target 并固定 UTF-8 编译契约", () => {
    const x64Config = resolveNativeWindowsBuildConfig({
      platform: "win32",
      arch: "x64",
      hostPlatform: "win32",
      hostArch: "x64",
      env: {},
    });
    expect(x64Config).toMatchObject({
      arch: "x64",
      cmake: "cmake",
      generator: "Visual Studio 17 2022",
      generatorArchitecture: "x64",
      platform: "win32",
    });
    const arm64Config = resolveNativeWindowsBuildConfig({
      platform: "win32",
      arch: "arm64",
      hostPlatform: "win32",
      hostArch: "x64",
      env: {},
    });
    expect(arm64Config).toMatchObject({
      arch: "arm64",
      generatorArchitecture: "ARM64",
      platform: "win32",
    });
    expect(x64Config).not.toHaveProperty("cargo");
    expect(arm64Config).not.toHaveProperty("cargo");
    expect(windowsNativeSearchCmake).toMatch(
      /target_compile_options\(zcode_ugrep_contract INTERFACE[\s\S]*?\/utf-8[\s\S]*?\n\)/,
    );
    expect(() =>
      resolveNativeWindowsBuildConfig({
        platform: "win32",
        arch: "x64",
        hostPlatform: "linux",
        hostArch: "x64",
      }),
    ).toThrow("must run on Windows");
  });

  it("Windows verifier 读取 PE machine/import table 并拒绝动态 CRT", () => {
    const root = mkdtempSync(join(tmpdir(), "zcode-native-search-pe-test-"));
    try {
      const validPath = join(root, "valid-ugrep.exe");
      const validArm64Path = join(root, "valid-arm64-ugrep.exe");
      const invalidPath = join(root, "invalid-ugrep.exe");
      const invalidThirdPartyPath = join(root, "invalid-third-party-ugrep.exe");
      writeFileSync(validPath, createPeFixture(0x8664, "KERNEL32.dll"));
      writeFileSync(validArm64Path, createPeFixture(0xaa64, "KERNEL32.dll"));
      writeFileSync(invalidPath, createPeFixture(0x8664, "api-ms-win-crt-runtime-l1-1-0.dll"));
      writeFileSync(invalidThirdPartyPath, createPeFixture(0x8664, "libpcre2-8-0.dll"));

      expect(readWindowsPeMetadata(validPath)).toEqual({
        imports: ["KERNEL32.dll"],
        machine: 0x8664,
      });
      expect(readWindowsPeMetadata(validArm64Path)).toEqual({
        imports: ["KERNEL32.dll"],
        machine: 0xaa64,
      });
      expect(() =>
        verifyBuiltNativeSearchProducerOutputs({
          ugrepPath: validPath,
          platform: "win32",
          arch: "x64",
          hostArch: "x64",
          hostPlatform: "linux",
          producerOutputIds: ["ugrep"],
        }),
      ).not.toThrow();
      expect(() =>
        verifyBuiltNativeSearchProducerOutputs({
          ugrepPath: validArm64Path,
          platform: "win32",
          arch: "arm64",
          hostArch: "arm64",
          hostPlatform: "linux",
          producerOutputIds: ["ugrep"],
        }),
      ).not.toThrow();
      expect(() =>
        verifyBuiltNativeSearchTools({
          ugrepPath: validPath,
          rgPath: validPath,
          platform: "win32",
          arch: "x64",
          hostArch: "x64",
          hostPlatform: "linux",
        }),
      ).not.toThrow();
      expect(() =>
        verifyBuiltNativeSearchTools({
          ugrepPath: invalidPath,
          rgPath: validPath,
          platform: "win32",
          arch: "x64",
          hostArch: "x64",
          hostPlatform: "linux",
        }),
      ).toThrow("non-static runtime dependencies: api-ms-win-crt-runtime-l1-1-0.dll");
      expect(() =>
        verifyBuiltNativeSearchTools({
          ugrepPath: invalidThirdPartyPath,
          rgPath: validPath,
          platform: "win32",
          arch: "x64",
          hostArch: "x64",
          hostPlatform: "linux",
        }),
      ).toThrow("non-static runtime dependencies: libpcre2-8-0.dll");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("下载侧静态 verifier 应按 Mach-O、ELF 与 PE header 拒绝错误目标架构", () => {
    const root = mkdtempSync(join(tmpdir(), "zcode-native-search-target-verifier-test-"));
    try {
      const machoPath = join(root, "darwin-arm64");
      const elfPath = join(root, "linux-x64");
      const pePath = join(root, "win32-x64.exe");
      writeFileSync(machoPath, createMachOFixture(0x0100000c));
      writeFileSync(elfPath, createElfFixture(0x3e));
      writeFileSync(pePath, createPeFixture(0x8664, "KERNEL32.dll"));

      expect(() =>
        verifyNativeSearchBinaryTarget(machoPath, { platform: "darwin", arch: "arm64" }),
      ).not.toThrow();
      expect(() =>
        verifyNativeSearchBinaryTarget(machoPath, { platform: "darwin", arch: "x64" }),
      ).toThrow("expected 0x1000007 for x64");
      expect(() =>
        verifyNativeSearchBinaryTarget(elfPath, { platform: "linux", arch: "x64" }),
      ).not.toThrow();
      expect(() =>
        verifyNativeSearchBinaryTarget(elfPath, { platform: "linux", arch: "arm64" }),
      ).toThrow("expected 0xb7 for arm64");
      expect(() =>
        verifyNativeSearchBinaryTarget(pePath, { platform: "win32", arch: "x64" }),
      ).not.toThrow();
      expect(() =>
        verifyNativeSearchBinaryTarget(pePath, { platform: "win32", arch: "arm64" }),
      ).toThrow("expected 0xaa64 for arm64");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function packageNativeSearchInTimezone(
  prebuiltPlan: ReturnType<typeof resolveNativeSearchPrebuiltPlan>,
  artifactsDir: string,
  timezone: string,
): void {
  const packageScriptUrl = pathToFileURL(
    join(import.meta.dirname, "../../../scripts/package-native-search-tools.mjs"),
  ).href;
  const script = `
    import { packNativeSearchPrebuiltArtifacts } from ${JSON.stringify(packageScriptUrl)};
    await packNativeSearchPrebuiltArtifacts(${JSON.stringify({ prebuiltPlan, artifactsDir })});
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    encoding: "utf8",
    env: { ...process.env, TZ: timezone },
  });
  if (result.status !== 0) {
    throw new Error(`timezone package failed (${timezone}):\n${result.stderr || result.stdout}`);
  }
}

function createMachOFixture(cpuType: number): Buffer {
  const buffer = Buffer.alloc(32);
  buffer.writeUInt32LE(0xfeedfacf, 0);
  buffer.writeUInt32LE(cpuType, 4);
  buffer.writeUInt32LE(2, 12);
  return buffer;
}

function createElfFixture(machine: number): Buffer {
  const buffer = Buffer.alloc(64);
  buffer.write("\x7fELF", 0, "binary");
  buffer[4] = 2;
  buffer[5] = 1;
  buffer.writeUInt16LE(3, 16);
  buffer.writeUInt16LE(machine, 18);
  return buffer;
}

function createPeFixture(machine: number, dependency: string): Buffer {
  const buffer = Buffer.alloc(1024);
  const peOffset = 0x80;
  const optionalHeaderOffset = peOffset + 24;
  const optionalHeaderSize = 0xf0;
  const sectionTableOffset = optionalHeaderOffset + optionalHeaderSize;
  const sectionRva = 0x1000;
  const sectionRawOffset = 0x200;

  buffer.write("MZ", 0, "ascii");
  buffer.writeUInt32LE(peOffset, 0x3c);
  buffer.write("PE\0\0", peOffset, "ascii");
  buffer.writeUInt16LE(machine, peOffset + 4);
  buffer.writeUInt16LE(1, peOffset + 6);
  buffer.writeUInt16LE(optionalHeaderSize, peOffset + 20);
  buffer.writeUInt16LE(0x20b, optionalHeaderOffset);
  buffer.writeUInt32LE(sectionRva, optionalHeaderOffset + 112 + 8);
  buffer.writeUInt32LE(40, optionalHeaderOffset + 112 + 12);
  buffer.writeUInt32LE(0x200, sectionTableOffset + 8);
  buffer.writeUInt32LE(sectionRva, sectionTableOffset + 12);
  buffer.writeUInt32LE(0x200, sectionTableOffset + 16);
  buffer.writeUInt32LE(sectionRawOffset, sectionTableOffset + 20);
  buffer.writeUInt32LE(sectionRva + 0x40, sectionRawOffset + 12);
  buffer.writeUInt32LE(sectionRva + 0x60, sectionRawOffset + 16);
  buffer.write(`${dependency}\0`, sectionRawOffset + 0x40, "ascii");
  return buffer;
}
