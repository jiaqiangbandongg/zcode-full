import { existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ZCODE_AGENT_RUNTIME } from "@zcode/shared";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

type RestoreReusableReleaseAssets = (options: {
  mockCdnDir: string;
  currentVersion: string;
  releaseDir: string;
  componentDefinitionsByPlatform: Map<
    string,
    Array<{ id: string; version: string; mount: string; requiredPaths?: string[] }>
  >;
}) => void;

let restoreReusableReleaseAssets: RestoreReusableReleaseAssets;
let buildContentAddressedComponentVersion: (semanticPrefix: string, sha256: string) => string;
let buildComponentArtifactRelativePath: (
  platformKey: string,
  componentId: string,
  componentVersion: string,
) => string;
let packComponentSourceAsArchive: (sourcePath: string, artifactPath: string) => void;
let buildRemoteComponentDefinitions: (platformKey: string) => Array<{
  id: string;
  semanticPrefix: string;
  mount: string;
  sourcePath: string;
}>;
let prepareRemoteComponentArtifact: (options: {
  mockCdnDir: string;
  platformKey: string;
  component: {
    id: string;
    semanticPrefix: string;
    mount: string;
    sourcePath: string;
  };
  previousComponents?: Map<string, Record<string, unknown>>;
}) => Record<string, unknown>;

const currentGlmManifestVersion = `v${ZCODE_AGENT_RUNTIME.version}`;

beforeAll(async () => {
  const moduleUrl = pathToFileURL(
    resolve(import.meta.dirname, "../../../scripts/prepare-prebuilds.mjs"),
  ).href;
  const module = (await import(moduleUrl)) as {
    restoreReusableReleaseAssets: RestoreReusableReleaseAssets;
    buildContentAddressedComponentVersion: (semanticPrefix: string, sha256: string) => string;
    buildComponentArtifactRelativePath: (
      platformKey: string,
      componentId: string,
      componentVersion: string,
    ) => string;
    packComponentSourceAsArchive: (sourcePath: string, artifactPath: string) => void;
    buildRemoteComponentDefinitions: typeof buildRemoteComponentDefinitions;
    prepareRemoteComponentArtifact: typeof prepareRemoteComponentArtifact;
  };
  restoreReusableReleaseAssets = module.restoreReusableReleaseAssets;
  buildContentAddressedComponentVersion = module.buildContentAddressedComponentVersion;
  buildComponentArtifactRelativePath = module.buildComponentArtifactRelativePath;
  packComponentSourceAsArchive = module.packComponentSourceAsArchive;
  buildRemoteComponentDefinitions = module.buildRemoteComponentDefinitions;
  prepareRemoteComponentArtifact = module.prepareRemoteComponentArtifact;
});

const tempDirs: string[] = [];

async function makeTempDir() {
  const dir = await mkdtemp(join(tmpdir(), "zcode-prepare-prebuilds-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

function writeManifest(
  releaseDir: string,
  platformKey: string,
  components: Array<{ id: string; version: string; mount: string }>,
) {
  writeFileSync(
    join(releaseDir, `manifest-${platformKey}.json`),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        appVersion: "1.10.0",
        platformArch: platformKey,
        components: components.map((component) => ({
          ...component,
          sha256: `sha-${component.id}`,
          artifactPath: `components/${platformKey}/${component.id}/${component.version}.tar.gz`,
        })),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function writeDefaultManifest(releaseDir: string, platformKey: string) {
  writeManifest(releaseDir, platformKey, [
    { id: "node-runtime", version: "v22.16.0", mount: `node/${platformKey}` },
    { id: "glm", version: "v0.0.1", mount: `glm/${platformKey}` },
    { id: "ripgrep", version: "v13.0.0-10", mount: `tools/${platformKey}/ripgrep` },
    { id: "server-bundle", version: "v1.10.0", mount: "server" },
  ]);
}

describe("prepare-prebuilds release asset reuse", () => {
  it("Linux remote 生成 native-search 三工具，Darwin 继续使用 legacy ripgrep", () => {
    expect(
      buildRemoteComponentDefinitions("linux-x64")
        .filter(({ id }) => id === "bfs" || id === "ripgrep" || id === "ugrep")
        .map(({ id, semanticPrefix, mount }) => ({ id, semanticPrefix, mount })),
    ).toEqual([
      {
        id: "bfs",
        semanticPrefix: "v4.1.1-2",
        mount: "tools/linux-x64/bfs",
      },
      {
        id: "ripgrep",
        semanticPrefix: "v14.1.1-1",
        mount: "tools/linux-x64/ripgrep",
      },
      {
        id: "ugrep",
        semanticPrefix: "v7.8.4-1",
        mount: "tools/linux-x64/ugrep",
      },
    ]);

    expect(
      buildRemoteComponentDefinitions("darwin-arm64")
        .filter(({ id }) => id === "bfs" || id === "ripgrep" || id === "ugrep")
        .map(({ id, semanticPrefix, mount }) => ({ id, semanticPrefix, mount })),
    ).toEqual([
      {
        id: "ripgrep",
        semanticPrefix: "v13.0.0-10",
        mount: "tools/darwin-arm64/ripgrep",
      },
    ]);
  });

  it("相同内容的 component archive 不应因文件 mtime 变化而改变 hash", async () => {
    const workDir = await makeTempDir();
    const sourceDir = join(workDir, "source");
    const firstArchive = join(workDir, "first.tar.gz");
    const secondArchive = join(workDir, "second.tar.gz");
    const filePath = join(sourceDir, "bin", "tool");

    mkdirSync(join(sourceDir, "bin"), { recursive: true });
    writeFileSync(filePath, "same-content", { encoding: "utf8", mode: 0o755 });
    utimesSync(
      filePath,
      new Date("2024-01-01T00:00:00.000Z"),
      new Date("2024-01-01T00:00:00.000Z"),
    );
    packComponentSourceAsArchive(sourceDir, firstArchive);

    utimesSync(
      filePath,
      new Date("2026-01-01T00:00:00.000Z"),
      new Date("2026-01-01T00:00:00.000Z"),
    );
    packComponentSourceAsArchive(sourceDir, secondArchive);

    expect(readFileSync(secondArchive)).toEqual(readFileSync(firstArchive));
  });

  it("component artifact path 应包含内容 hash，避免同版本覆盖 CDN 对象", () => {
    const componentVersion = buildContentAddressedComponentVersion(
      "v22.16.0",
      "1d922b3d02e42747d5d7e31c2da9823abc062064744ec94194b56ea26bf15426",
    );

    expect(componentVersion).toBe("v22.16.0+1d922b3d02e4");
    expect(
      buildComponentArtifactRelativePath("linux-arm64", "node-runtime", componentVersion),
    ).toBe("components/linux-arm64/node-runtime/v22.16.0+1d922b3d02e4.tar.gz");
  });

  it("component 源内容未变化时应复用已有 artifact，避免重复打包", async () => {
    const mockCdnDir = await makeTempDir();
    const platformKey = "linux-x64";
    const sourceDir = join(mockCdnDir, "releases", "1.11.0", "node", platformKey);
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, "node"), "node-runtime", "utf8");

    const firstEntry = prepareRemoteComponentArtifact({
      mockCdnDir,
      platformKey,
      component: {
        id: "node-runtime",
        semanticPrefix: "v22.16.0",
        mount: `node/${platformKey}`,
        sourcePath: sourceDir,
      },
    });
    const artifactPath = join(mockCdnDir, ...String(firstEntry.artifactPath).split("/"));
    const artifactMtimeMs = statSync(artifactPath).mtimeMs;

    const secondEntry = prepareRemoteComponentArtifact({
      mockCdnDir,
      platformKey,
      component: {
        id: "node-runtime",
        semanticPrefix: "v22.16.0",
        mount: `node/${platformKey}`,
        sourcePath: sourceDir,
      },
      previousComponents: new Map([["node-runtime", firstEntry]]),
    });

    expect(secondEntry).toEqual(firstEntry);
    expect(statSync(artifactPath).mtimeMs).toBe(artifactMtimeMs);
  });

  it("component 源内容变化时应重新生成 artifact", async () => {
    const mockCdnDir = await makeTempDir();
    const platformKey = "linux-x64";
    const sourceDir = join(mockCdnDir, "releases", "1.11.0", "tools", platformKey, "ripgrep");
    const sourceFile = join(sourceDir, "rg");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(sourceFile, "rg-v1", "utf8");

    const firstEntry = prepareRemoteComponentArtifact({
      mockCdnDir,
      platformKey,
      component: {
        id: "ripgrep",
        semanticPrefix: "v13.0.0-10",
        mount: `tools/${platformKey}/ripgrep`,
        sourcePath: sourceDir,
      },
    });

    writeFileSync(sourceFile, "rg-v2", "utf8");

    const secondEntry = prepareRemoteComponentArtifact({
      mockCdnDir,
      platformKey,
      component: {
        id: "ripgrep",
        semanticPrefix: "v13.0.0-10",
        mount: `tools/${platformKey}/ripgrep`,
        sourcePath: sourceDir,
      },
      previousComponents: new Map([["ripgrep", firstEntry]]),
    });

    expect(secondEntry.artifactPath).not.toBe(firstEntry.artifactPath);
    expect(secondEntry.sourceSha256).not.toBe(firstEntry.sourceSha256);
  });

  it("复用历史 release 时应忽略 component version 的内容 hash 后缀", async () => {
    const mockCdnDir = await makeTempDir();
    const previousReleaseDir = join(mockCdnDir, "releases", "1.10.0");
    const currentReleaseDir = join(mockCdnDir, "releases", "1.11.0");
    const platformKey = "linux-x64";

    mkdirSync(join(previousReleaseDir, "node", platformKey), { recursive: true });
    writeFileSync(join(previousReleaseDir, "node", platformKey, "node"), "old-node", "utf8");
    writeManifest(previousReleaseDir, platformKey, [
      {
        id: "node-runtime",
        version: "v22.16.0+aaaaaaaaaaaa",
        mount: `node/${platformKey}`,
      },
    ]);

    restoreReusableReleaseAssets({
      mockCdnDir,
      currentVersion: "1.11.0",
      releaseDir: currentReleaseDir,
      componentDefinitionsByPlatform: new Map([
        [platformKey, [{ id: "node-runtime", version: "v22.16.0", mount: `node/${platformKey}` }]],
      ]),
    });

    expect(readFileSync(join(currentReleaseDir, "node", platformKey, "node"), "utf8")).toBe(
      "old-node",
    );
  });

  it("glm 资源不应跨 release 复用，避免远端 agent 协议 schema 滞后", async () => {
    const mockCdnDir = await makeTempDir();
    const previousReleaseDir = join(mockCdnDir, "releases", "1.10.0");
    const currentReleaseDir = join(mockCdnDir, "releases", "1.11.0");
    const platformKey = "linux-x64";

    mkdirSync(join(previousReleaseDir, "glm", platformKey), { recursive: true });
    writeFileSync(join(previousReleaseDir, "glm", platformKey, "zcode.cjs"), "old-glm", "utf8");
    writeManifest(previousReleaseDir, platformKey, [
      { id: "glm", version: currentGlmManifestVersion, mount: `glm/${platformKey}` },
    ]);

    restoreReusableReleaseAssets({
      mockCdnDir,
      currentVersion: "1.11.0",
      releaseDir: currentReleaseDir,
      componentDefinitionsByPlatform: new Map([
        [
          platformKey,
          [
            {
              id: "glm",
              version: currentGlmManifestVersion,
              mount: `glm/${platformKey}`,
              requiredPaths: ["zcode.cjs"],
            },
          ],
        ],
      ]),
    });

    expect(existsSync(join(currentReleaseDir, "glm", platformKey, "zcode.cjs"))).toBe(false);
  });

  it("新 app version 应从最近历史 release 复用版本一致且允许复用的资源", async () => {
    const mockCdnDir = await makeTempDir();
    const previousReleaseDir = join(mockCdnDir, "releases", "1.10.0");
    const currentReleaseDir = join(mockCdnDir, "releases", "1.11.0");
    const platformKey = "linux-x64";

    mkdirSync(join(previousReleaseDir, "node", platformKey), { recursive: true });
    mkdirSync(join(previousReleaseDir, "tools", platformKey, "ripgrep"), { recursive: true });
    mkdirSync(join(previousReleaseDir, "server"), { recursive: true });
    writeFileSync(join(previousReleaseDir, "node", platformKey, "node"), "old-node", "utf8");
    writeFileSync(
      join(previousReleaseDir, "tools", platformKey, "ripgrep", "rg"),
      "old-rg",
      "utf8",
    );
    writeFileSync(join(previousReleaseDir, "server", "zcode-server.cjs"), "old-server", "utf8");
    writeDefaultManifest(previousReleaseDir, platformKey);

    restoreReusableReleaseAssets({
      mockCdnDir,
      currentVersion: "1.11.0",
      releaseDir: currentReleaseDir,
      componentDefinitionsByPlatform: new Map([
        [
          platformKey,
          [
            {
              id: "node-runtime",
              version: "v22.16.0",
              mount: `node/${platformKey}`,
            },
            {
              id: "ripgrep",
              version: "v13.0.0-10",
              mount: `tools/${platformKey}/ripgrep`,
            },
            {
              id: "server-bundle",
              version: "v1.11.0",
              mount: "server",
            },
          ],
        ],
      ]),
    });

    expect(readFileSync(join(currentReleaseDir, "node", platformKey, "node"), "utf8")).toBe(
      "old-node",
    );
    expect(
      readFileSync(join(currentReleaseDir, "tools", platformKey, "ripgrep", "rg"), "utf8"),
    ).toBe("old-rg");
    expect(() =>
      readFileSync(join(currentReleaseDir, "server", "zcode-server.cjs"), "utf8"),
    ).toThrow();
  });

  it("最近历史 release 不完整时应继续回退到更早可用 release", async () => {
    const mockCdnDir = await makeTempDir();
    const currentReleaseDir = join(mockCdnDir, "releases", "1.11.0");
    const incompleteReleaseDir = join(mockCdnDir, "releases", "1.10.0");
    const fallbackReleaseDir = join(mockCdnDir, "releases", "1.9.0");
    const platformKey = "linux-x64";

    mkdirSync(incompleteReleaseDir, { recursive: true });
    mkdirSync(join(fallbackReleaseDir, "node", platformKey), { recursive: true });
    writeFileSync(join(fallbackReleaseDir, "node", platformKey, "node"), "fallback-node", "utf8");
    writeManifest(fallbackReleaseDir, platformKey, [
      { id: "node-runtime", version: "v22.16.0", mount: `node/${platformKey}` },
    ]);

    restoreReusableReleaseAssets({
      mockCdnDir,
      currentVersion: "1.11.0",
      releaseDir: currentReleaseDir,
      componentDefinitionsByPlatform: new Map([
        [platformKey, [{ id: "node-runtime", version: "v22.16.0", mount: `node/${platformKey}` }]],
      ]),
    });

    expect(readFileSync(join(currentReleaseDir, "node", platformKey, "node"), "utf8")).toBe(
      "fallback-node",
    );
  });

  it("不应从高于当前 app version 的未来 release 复用资源", async () => {
    const mockCdnDir = await makeTempDir();
    const currentReleaseDir = join(mockCdnDir, "releases", "1.11.0");
    const futureReleaseDir = join(mockCdnDir, "releases", "1.12.0");
    const previousReleaseDir = join(mockCdnDir, "releases", "1.10.0");
    const platformKey = "linux-x64";

    mkdirSync(join(futureReleaseDir, "node", platformKey), { recursive: true });
    mkdirSync(join(previousReleaseDir, "node", platformKey), { recursive: true });
    writeFileSync(join(futureReleaseDir, "node", platformKey, "node"), "future-node", "utf8");
    writeFileSync(join(previousReleaseDir, "node", platformKey, "node"), "previous-node", "utf8");
    writeManifest(futureReleaseDir, platformKey, [
      { id: "node-runtime", version: "v22.16.0", mount: `node/${platformKey}` },
    ]);
    writeManifest(previousReleaseDir, platformKey, [
      { id: "node-runtime", version: "v22.16.0", mount: `node/${platformKey}` },
    ]);

    restoreReusableReleaseAssets({
      mockCdnDir,
      currentVersion: "1.11.0",
      releaseDir: currentReleaseDir,
      componentDefinitionsByPlatform: new Map([
        [platformKey, [{ id: "node-runtime", version: "v22.16.0", mount: `node/${platformKey}` }]],
      ]),
    });

    expect(readFileSync(join(currentReleaseDir, "node", platformKey, "node"), "utf8")).toBe(
      "previous-node",
    );
  });

  it("required paths 不完整时不应复制残缺资源目录", async () => {
    const mockCdnDir = await makeTempDir();
    const currentReleaseDir = join(mockCdnDir, "releases", "1.11.0");
    const previousReleaseDir = join(mockCdnDir, "releases", "1.10.0");
    const platformKey = "darwin-arm64";

    mkdirSync(join(previousReleaseDir, "node-pty", platformKey), { recursive: true });
    writeFileSync(join(previousReleaseDir, "node-pty", platformKey, "pty.node"), "pty", "utf8");
    writeManifest(previousReleaseDir, platformKey, [
      { id: "node-pty", version: "v1.2.0", mount: `node-pty/${platformKey}` },
    ]);

    restoreReusableReleaseAssets({
      mockCdnDir,
      currentVersion: "1.11.0",
      releaseDir: currentReleaseDir,
      componentDefinitionsByPlatform: new Map([
        [
          platformKey,
          [
            {
              id: "node-pty",
              version: "v1.2.0",
              mount: `node-pty/${platformKey}`,
              requiredPaths: ["pty.node", "spawn-helper"],
            },
          ],
        ],
      ]),
    });

    expect(existsSync(join(currentReleaseDir, "node-pty", platformKey))).toBe(false);
  });

  it("当前 release 已有残缺目录时应继续用历史 release 修复", async () => {
    const mockCdnDir = await makeTempDir();
    const currentReleaseDir = join(mockCdnDir, "releases", "1.11.0");
    const previousReleaseDir = join(mockCdnDir, "releases", "1.10.0");
    const platformKey = "linux-arm64";

    mkdirSync(join(currentReleaseDir, "node-pty", platformKey), { recursive: true });
    mkdirSync(join(previousReleaseDir, "node-pty", platformKey), { recursive: true });
    writeFileSync(
      join(currentReleaseDir, "node-pty", platformKey, ".node-pty-dl-123.part"),
      "partial",
      "utf8",
    );
    writeFileSync(
      join(previousReleaseDir, "node-pty", platformKey, "pty.node"),
      "previous-pty",
      "utf8",
    );
    writeManifest(previousReleaseDir, platformKey, [
      { id: "node-pty", version: "v1.2.0", mount: `node-pty/${platformKey}` },
    ]);

    restoreReusableReleaseAssets({
      mockCdnDir,
      currentVersion: "1.11.0",
      releaseDir: currentReleaseDir,
      componentDefinitionsByPlatform: new Map([
        [
          platformKey,
          [
            {
              id: "node-pty",
              version: "v1.2.0",
              mount: `node-pty/${platformKey}`,
              requiredPaths: ["pty.node"],
            },
          ],
        ],
      ]),
    });

    expect(readFileSync(join(currentReleaseDir, "node-pty", platformKey, "pty.node"), "utf8")).toBe(
      "previous-pty",
    );
    expect(
      existsSync(join(currentReleaseDir, "node-pty", platformKey, ".node-pty-dl-123.part")),
    ).toBe(false);
  });
});
