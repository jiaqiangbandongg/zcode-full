import { createHash } from "node:crypto";
import {
  createReadStream,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { packSourceAsDeterministicTarGzip } from "../../../scripts/deterministic-tar-archive.mjs";
import { downloadNativeSearchTools } from "../../../scripts/download-native-search-tools.mjs";
import {
  resolveNativeSearchBundleMetaPath,
  writeNativeSearchBundleMeta,
} from "../../../scripts/native-search-tools-bundle-meta.mjs";
import { resolveNativeSearchPrebuiltPlan } from "../../../scripts/native-search-tools-config.mjs";
import {
  downloadPrebuiltArchive,
  downloadAndExtractPrebuiltBinary,
  shouldUsePrebuiltDownloadProxy,
  verifyPrebuiltArchiveSha256,
} from "../../../scripts/prebuilt-binary-download.mjs";

const temporaryDirectories: string[] = [];

function createTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "zcode-native-search-download-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function createMachOFixture(arch: "arm64" | "x64", label: string): Buffer {
  const labelBytes = Buffer.from(label);
  const buffer = Buffer.alloc(32 + labelBytes.length);
  buffer.writeUInt32LE(0xfeedfacf, 0);
  buffer.writeUInt32LE(arch === "arm64" ? 0x0100000c : 0x01000007, 4);
  buffer.writeUInt32LE(2, 12);
  labelBytes.copy(buffer, 32);
  return buffer;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("downloadNativeSearchTools", () => {
  it("下载响应中途断开时清理半截归档并明确失败", async () => {
    const root = createTemporaryDirectory();
    const archivePath = join(root, "partial-archive.tar.gz");
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-length": 1024 });
      response.flushHeaders();
      response.write("partial archive");
      setTimeout(() => response.destroy(), 10);
    });
    await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));

    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("test server has no TCP port");

      await expect(
        downloadPrebuiltArchive(`http://127.0.0.1:${address.port}/archive`, archivePath),
      ).rejects.toThrow("Download aborted before completion");
      expect(existsSync(archivePath)).toBe(false);
    } finally {
      await new Promise<void>((resolvePromise, rejectPromise) => {
        server.close((error) => (error ? rejectPromise(error) : resolvePromise()));
      });
    }
  });

  it("只为固定的 GitHub release 主机启用下载代理", () => {
    expect(
      shouldUsePrebuiltDownloadProxy(
        "https://github.com/microsoft/ripgrep-prebuilt/releases/download/v14.1.1-1/rg.tar.gz",
      ),
    ).toBe(true);
    expect(
      shouldUsePrebuiltDownloadProxy(
        "https://release-assets.githubusercontent.com/asset/rg.tar.gz",
      ),
    ).toBe(true);
    expect(
      shouldUsePrebuiltDownloadProxy(
        "http://intranet.example.invalid:12345/zcode/deps/native-search-tools/rg.tar.gz",
      ),
    ).toBe(false);
    expect(shouldUsePrebuiltDownloadProxy("https://github.com.example.test/rg.tar.gz")).toBe(false);
  });

  it("从预编译归档安装目标工具，已存在时跳过，缺失时失败", async () => {
    const root = createTemporaryDirectory();
    const archives = new Map<string, string>();
    let requestCount = 0;
    const server = createServer((request, response) => {
      requestCount += 1;
      const archivePath = archives.get(request.url ?? "");
      if (!archivePath) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { "content-type": "application/gzip" });
      createReadStream(archivePath).pipe(response);
    });
    await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));

    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("test server has no TCP port");
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const env = {
        NATIVE_SEARCH_RIPGREP_DOWNLOAD_BASE_URL: `${baseUrl}/microsoft-ripgrep`,
        NATIVE_SEARCH_TOOLS_DOWNLOAD_BASE_URL: baseUrl,
      };
      const outputDir = join(root, "output");
      const plan = resolveNativeSearchPrebuiltPlan({
        platform: "darwin",
        arch: "arm64",
        outputDir,
        env,
      });
      const fixtures = new Map<string, Buffer>();

      for (const artifact of plan.artifacts) {
        const sourcePath = join(root, artifact.binaryName);
        const archivePath = join(root, artifact.releaseFileName);
        const fixture = createMachOFixture("arm64", `${artifact.toolId}-fixture`);
        fixtures.set(artifact.toolId, fixture);
        if (artifact.source === "official") {
          mkdirSync(join(outputDir, artifact.toolId), { recursive: true });
          writeFileSync(artifact.binaryPath, fixture);
          chmodSync(artifact.binaryPath, 0o755);
          writeNativeSearchBundleMeta(artifact, plan.platformKey);
        } else {
          writeFileSync(sourcePath, fixture);
          chmodSync(sourcePath, 0o755);
          packSourceAsDeterministicTarGzip(sourcePath, archivePath);
          artifact.archiveSha256 = createHash("sha256")
            .update(readFileSync(archivePath))
            .digest("hex");
          archives.set(new URL(artifact.downloadUrl).pathname, archivePath);
        }
      }

      await downloadNativeSearchTools({
        prebuiltPlan: plan,
      });
      expect(readFileSync(plan.bfsPath)).toEqual(fixtures.get("bfs"));
      expect(readFileSync(plan.rgPath)).toEqual(fixtures.get("ripgrep"));
      expect(readFileSync(plan.ugrepPath)).toEqual(fixtures.get("ugrep"));
      expect(requestCount).toBe(2);
      expect(
        JSON.parse(readFileSync(resolveNativeSearchBundleMetaPath(plan.rgPath), "utf8")),
      ).toMatchObject({ source: "official" });

      await downloadNativeSearchTools({
        prebuiltPlan: plan,
      });
      expect(requestCount).toBe(2);

      if (process.platform !== "win32") {
        chmodSync(plan.bfsPath, 0o644);
        await downloadNativeSearchTools({
          prebuiltPlan: plan,
        });
        expect(requestCount).toBe(2);
        expect(statSync(plan.bfsPath).mode & 0o111).not.toBe(0);
      }

      const ugrepArtifact = plan.artifacts.find(({ toolId }) => toolId === "ugrep");
      if (!ugrepArtifact) throw new Error("ugrep artifact is missing");
      writeFileSync(ugrepArtifact.binaryPath, createMachOFixture("x64", "wrong-arch-cache"));
      writeNativeSearchBundleMeta(ugrepArtifact, plan.platformKey);

      await downloadNativeSearchTools({
        prebuiltPlan: plan,
      });
      expect(requestCount).toBe(3);
      expect(readFileSync(plan.ugrepPath)).toEqual(fixtures.get("ugrep"));

      const invalidArchivePath = join(root, "invalid-ugrep.tar.gz");
      const ugrepSourcePath = join(root, ugrepArtifact.binaryName);
      writeFileSync(ugrepSourcePath, createMachOFixture("x64", "wrong-arch-download"));
      packSourceAsDeterministicTarGzip(ugrepSourcePath, invalidArchivePath);
      archives.set(new URL(ugrepArtifact.downloadUrl).pathname, invalidArchivePath);
      const invalidOutputDir = join(root, "invalid-output");
      const invalidPlan = resolveNativeSearchPrebuiltPlan({
        platform: "darwin",
        arch: "arm64",
        outputDir: invalidOutputDir,
        env,
      });
      for (const artifact of invalidPlan.artifacts.filter(({ source }) => source === "producer")) {
        const archivePath = archives.get(new URL(artifact.downloadUrl).pathname);
        if (!archivePath) throw new Error(`fixture archive is missing for ${artifact.toolId}`);
        artifact.archiveSha256 = createHash("sha256")
          .update(readFileSync(archivePath))
          .digest("hex");
      }
      await expect(
        downloadNativeSearchTools({
          prebuiltPlan: invalidPlan,
        }),
      ).rejects.toThrow("expected 0x100000c for arm64");
      expect(existsSync(invalidPlan.rgPath)).toBe(false);
      expect(existsSync(resolveNativeSearchBundleMetaPath(invalidPlan.rgPath))).toBe(false);

      const missingOutputDir = join(root, "missing-output");
      await expect(
        downloadNativeSearchTools({
          platform: "darwin",
          arch: "arm64",
          outputDir: missingOutputDir,
          env: {
            ...env,
            NATIVE_SEARCH_TOOLS_DOWNLOAD_BASE_URL: `${baseUrl}/missing`,
          },
        }),
      ).rejects.toThrow("Download failed: HTTP 404");
      expect(existsSync(join(missingOutputDir, "bfs", "bfs"))).toBe(false);
    } finally {
      await new Promise<void>((resolvePromise, rejectPromise) => {
        server.close((error) => (error ? rejectPromise(error) : resolvePromise()));
      });
    }
  });

  it("在解包前按可信摘要校验预编译归档", () => {
    const root = createTemporaryDirectory();
    const archivePath = join(root, "archive.tar.gz");
    writeFileSync(archivePath, "official-archive-fixture");
    const expectedSha256 = createHash("sha256").update(readFileSync(archivePath)).digest("hex");

    expect(() => verifyPrebuiltArchiveSha256(archivePath, expectedSha256)).not.toThrow();
    expect(() => verifyPrebuiltArchiveSha256(archivePath, "0".repeat(64))).toThrow(
      "Archive SHA-256 mismatch",
    );
  });

  it("缺少归档摘要时在下载前失败", async () => {
    const root = createTemporaryDirectory();

    await expect(
      downloadAndExtractPrebuiltBinary({
        archiveExt: "tar.gz",
        binaryName: "ugrep",
        binaryPath: join(root, "output", "ugrep"),
        cwd: root,
        downloadUrl: "http://127.0.0.1:1/unreachable",
        targetPlatform: "darwin",
      }),
    ).rejects.toThrow("missing prebuilt archive SHA-256");
  });
});
