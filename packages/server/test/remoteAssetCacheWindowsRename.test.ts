import { createHash } from "node:crypto";
import * as realFsPromises from "node:fs/promises";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZCODE_VERSION } from "@zcode/shared";
import { createTarGzArchive } from "@zcode/server/remote/localTarGz.js";

function remoteAssetRenameEperm(): NodeJS.ErrnoException {
  const error = new Error("operation not permitted, rename") as NodeJS.ErrnoException;
  error.code = "EPERM";
  error.errno = -4048;
  error.syscall = "rename";
  return error;
}

async function writeComponentArchive(options: {
  sourceRoot: string;
  cdnRoot: string;
  platformArch: string;
  id: string;
  version: string;
  mount: string;
  artifactPath: string;
}): Promise<string> {
  const archivePath = join(options.cdnRoot, options.artifactPath);
  const sourcePath = join(options.sourceRoot, ...options.mount.split("/"));
  const entries = await readdir(sourcePath);
  await createTarGzArchive(
    archivePath,
    entries.map((entry) => ({
      sourcePath: join(sourcePath, entry),
      archivePath: entry,
    })),
  );
  return createHash("sha256").update(await readFile(archivePath)).digest("hex");
}

describe("remote asset cache Windows directory commit", () => {
  afterEach(async () => {
    vi.doUnmock("node:fs/promises");
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("retries transient EPERM while committing a staged release component directory", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-remote-cache-rename-"));
    const sourceRoot = join(rootDir, "source");
    const cdnRoot = join(rootDir, "cdn", ZCODE_VERSION);
    const remoteCacheDir = join(rootDir, "remote-cache");
    const platformArch = "linux-x64";
    const failedRenameTargets: string[] = [];

    try {
      await mkdir(join(sourceRoot, "server"), { recursive: true });
      await mkdir(join(sourceRoot, "node", platformArch), { recursive: true });
      await mkdir(join(sourceRoot, "glm", platformArch), { recursive: true });
      await writeFile(join(sourceRoot, "server", "zcode-server.cjs"), "server", "utf8");
      await writeFile(join(sourceRoot, "node", platformArch, "node"), "node", "utf8");
      await writeFile(join(sourceRoot, "glm", platformArch, "zcode-agent"), "glm", "utf8");

      const components = [
        {
          id: "server-bundle",
          version: `${ZCODE_VERSION}-server-bundle`,
          artifactPath: `components/${platformArch}/server-bundle.tar.gz`,
          mount: "server",
        },
        {
          id: "node-runtime",
          version: "24.10.0-node-runtime",
          artifactPath: `components/${platformArch}/node-runtime.tar.gz`,
          mount: `node/${platformArch}`,
        },
        {
          id: "glm",
          version: "3.1.2-glm",
          artifactPath: `components/${platformArch}/glm.tar.gz`,
          mount: `glm/${platformArch}`,
        },
      ];
      const manifestComponents = [];
      for (const component of components) {
        manifestComponents.push({
          ...component,
          sha256: await writeComponentArchive({
            sourceRoot,
            cdnRoot,
            platformArch,
            ...component,
          }),
        });
      }
      const glmSha256 = manifestComponents.find(
        (component) => component.id === "glm",
      )?.sha256;
      if (!glmSha256) {
        throw new Error("missing GLM component SHA");
      }
      await writeFile(
        join(cdnRoot, `manifest-${platformArch}.json`),
        JSON.stringify(
          {
            schemaVersion: 1,
            appVersion: ZCODE_VERSION,
            platformArch,
            components: manifestComponents,
          },
          null,
          2,
        ),
        "utf8",
      );

      vi.doMock("node:fs/promises", async () => {
        const actual = await vi.importActual<typeof realFsPromises>("node:fs/promises");
        let failedGlmReleaseCommit = false;
        return {
          ...actual,
          rename: vi.fn(async (from: string, to: string) => {
            const normalizedTo = normalize(to);
            if (
              !failedGlmReleaseCommit &&
              normalizedTo.endsWith(normalize(join("glm", platformArch)))
            ) {
              failedGlmReleaseCommit = true;
              failedRenameTargets.push(normalizedTo);
              throw remoteAssetRenameEperm();
            }
            return actual.rename(from, to);
          }),
        };
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => {
          const url = String(input);
          if (!url.startsWith("file:")) {
            return new Response(null, { status: 404 });
          }
          try {
            const body = await readFile(fileURLToPath(url));
            return new Response(body, {
              status: 200,
              headers: { "content-length": String(body.byteLength) },
            });
          } catch {
            return new Response(null, { status: 404 });
          }
        }),
      );

      const { ensureRemoteReleaseDirFromCdn } = await import(
        "@zcode/server/remote/remoteAssetCache.js"
      );
      const releaseDir = await ensureRemoteReleaseDirFromCdn(
        {
          remoteCdnBaseUrl: pathToFileURL(join(rootDir, "cdn")).href,
          remoteCacheDir,
          version: ZCODE_VERSION,
          platformArch,
        },
        { log: () => undefined, logWarn: () => undefined },
      );

      expect(releaseDir).toBe(
        join(
          remoteCacheDir,
          "releases",
          ZCODE_VERSION,
          platformArch,
          "glm-content",
          glmSha256,
        ),
      );
      expect(failedRenameTargets).toHaveLength(1);
      await expect(
        readFile(join(releaseDir, "glm", platformArch, "zcode-agent"), "utf8"),
      ).resolves.toBe("glm");
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  });
});
