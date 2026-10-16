import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import {
  cp,
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IDisposable, Event } from "@zcode/rpc";
import {
  getRemoteRuntimeToolsForPlatform,
  ZCODE_AGENT_RUNTIME,
  ZCODE_RUNTIME_ENV_KEY,
  ZCODE_VERSION,
} from "@zcode/shared";
import type {
  IRemoteBackend,
  StdioStream,
} from "@zcode/server/remote/backend.js";
import { deployZCodeAgentRuntime } from "@zcode/server/remote/zcodeAgentDeploy.js";
import { deployServer } from "@zcode/server/remote/deploy.js";
import {
  createRemoteComponentVersionResolver,
  deployNodeRuntime,
} from "@zcode/server/remote/remoteAssetDeployDecision.js";
import { buildRemoteExecutableReplaceCommand } from "@zcode/server/remote/deployShared.js";
import { ensureRemoteReleaseDirFromCdn } from "@zcode/server/remote/remoteAssetCache.js";
import {
  fetchRemoteDownloadManifest,
  type RemoteAssetInstaller,
} from "@zcode/server/remote/remoteAssetInstaller.js";
import { createTarGzArchive } from "@zcode/server/remote/localTarGz.js";
import { buildRemoteAgentBundleWrapper } from "@zcode/server/remote/zcodeAgentBundleWrapper.js";
import {
  REMOTE_AGENT_OFFICIAL_PLUGIN_INCLUDED_TOP_LEVEL_PATHS,
  REMOTE_AGENT_OFFICIAL_PLUGIN_PACKAGE_NAMES,
  REMOTE_AGENT_OFFICIAL_PLUGIN_REQUIRED_RELATIVE_PATHS,
} from "@zcode/server/remote/zcodeAgentOfficialPluginAssets.js";

const retiredProtocolPrefix = `${"a"}${"cp"}`;
const retiredProxyRuntimeId = `${retiredProtocolPrefix}-proxy-runtime`;
// 远端 ZCode Agent bundle 文件名（与 REMOTE_AGENT_BUNDLE_NAME 保持一致）。
const REMOTE_AGENT_BUNDLE_FILE_NAME = "zcode.cjs";
const REMOTE_AGENT_WRAPPER_FILE_NAME = "zcode-agent";
const BROWSER_USE_REQUIRED_RELATIVE_PATHS = [
  // node_repl 宿主已抽成 @zcode/node-repl-host，browser-use 不再产出 dist/mcp/server.js。
  "browser-use-plugin/docs/api.json",
  "browser-use-plugin/docs/documents.json",
  "browser-use-plugin/docs/overview.md",
  "browser-use-plugin/docs/recording.md",
  "browser-use-plugin/docs/workflow.md",
  "browser-use-plugin/scripts/browser-client.mjs",
  "browser-use-plugin/skills/control-browser/SKILL.md",
  "browser-use-plugin/skills/web-gui-tester/SKILL.md",
] as const;
// Bug 根因：remote fixture 曾复制一份旧的官方插件资产清单；生产合同加入 CUA SDK/docs/skill
// 后 fixture 仍生成不含这些文件的 GLM archive，所有部署测试都会误报 packages 缺失。
// 测试数据必须直接复用生产常量，后续新增官方资产时不能再静默漂移。
const OFFICIAL_PLUGIN_PACKAGE_NAMES =
  REMOTE_AGENT_OFFICIAL_PLUGIN_PACKAGE_NAMES;
const OFFICIAL_PLUGIN_REQUIRED_RELATIVE_PATHS =
  REMOTE_AGENT_OFFICIAL_PLUGIN_REQUIRED_RELATIVE_PATHS;
const OFFICIAL_PLUGIN_INCLUDED_TOP_LEVEL_PATHS =
  REMOTE_AGENT_OFFICIAL_PLUGIN_INCLUDED_TOP_LEVEL_PATHS;
const TEST_GLM_ARTIFACT_SHA256 = "a".repeat(64);

type LegacyRemoteTestAgentRuntime = {
  binaryKind: "node-script" | "native-binary";
  bundledResourceDir: string;
  version: string;
  resolveEntrySegments(platform: string): string[];
};

function resolveTestPlatformBinaryName(
  binaryName: string,
  platform: string,
): string {
  return platform === "win32" ? `${binaryName}.exe` : binaryName;
}

const LEGACY_REMOTE_TEST_AGENT_RUNTIME: Record<
  "claude" | "opencode" | "gemini" | "codex" | "glm",
  LegacyRemoteTestAgentRuntime
> = {
  claude: {
    binaryKind: "node-script",
    bundledResourceDir: retiredProtocolPrefix,
    version: "0.29.2",
    resolveEntrySegments: () => ["dist", "index.js"],
  },
  opencode: {
    binaryKind: "native-binary",
    bundledResourceDir: "opencode",
    version: "1.15.6",
    resolveEntrySegments: (platform) => [
      resolveTestPlatformBinaryName("opencode", platform),
    ],
  },
  gemini: {
    binaryKind: "node-script",
    bundledResourceDir: "gemini",
    version: "0.37.0",
    resolveEntrySegments: () => ["gemini.js"],
  },
  codex: {
    binaryKind: "node-script",
    bundledResourceDir: "codex",
    version: "0.12.0",
    resolveEntrySegments: () => [
      "node_modules",
      "@zed-industries",
      `codex-${retiredProtocolPrefix}`,
      "bin",
      `codex-${retiredProtocolPrefix}.js`,
    ],
  },
  glm: {
    binaryKind: "native-binary",
    bundledResourceDir: "glm",
    version: ZCODE_AGENT_RUNTIME.version,
    resolveEntrySegments: (platform) => [
      resolveTestPlatformBinaryName("zcode-agent", platform),
    ],
  },
};

type RemotePlatformKey =
  | "linux-arm64"
  | "linux-x64"
  | "darwin-arm64"
  | "darwin-x64";

interface RemoteComponentManifestItem {
  id: string;
  version: string;
  sha256: string;
  artifactPath: string;
  mount: string;
}

interface RemoteComponentManifest {
  schemaVersion: number;
  appVersion: string;
  platformArch: RemotePlatformKey;
  components: RemoteComponentManifestItem[];
}

interface RemoteComponentArtifactSpec {
  id: string;
  version: string;
  artifactPath: string;
  mount: string;
  sourcePath: string;
}

interface StageRemoteComponentArtifactsOptions {
  platformKey?: RemotePlatformKey;
  writeManifest?: boolean;
  mutateManifest?: (
    manifest: RemoteComponentManifest,
  ) => RemoteComponentManifest;
}

class FakeRemoteBackend implements IRemoteBackend {
  readonly uploads: Array<{ localPath: string; remotePath: string }> = [];
  readonly commands: string[] = [];
  readonly remoteFiles = new Map<string, string>();
  readonly lockReleaseMarkers: string[] = [];
  private readonly commandPlans: Array<{
    matcher: RegExp;
    exitCode: number;
    stdoutText?: string;
    stderrText?: string;
    onExec?: () => void;
  }>;
  private readonly serverVersions: Array<string | (() => string)>;
  private readonly lockCloseCode: number;
  private readonly lockAcquireGate?: Promise<void>;

  constructor(
    initialFiles: Record<string, string> = {},
    options: {
      commandPlans?: Array<{
        matcher: RegExp;
        exitCode: number;
        stdoutText?: string;
        stderrText?: string;
        onExec?: () => void;
      }>;
      serverVersion?: string | (() => string);
      serverVersions?: Array<string | (() => string)>;
      lockCloseCode?: number;
      lockAcquireGate?: Promise<void>;
    } = {},
  ) {
    this.commandPlans = options.commandPlans ?? [];
    this.serverVersions = options.serverVersions?.slice() ?? [
      options.serverVersion ?? ZCODE_VERSION,
    ];
    this.lockCloseCode = options.lockCloseCode ?? 0;
    this.lockAcquireGate = options.lockAcquireGate;
    for (const [path, content] of Object.entries(initialFiles)) {
      this.remoteFiles.set(path, content);
    }
  }

  dispose(): void {}

  async detect() {
    return { platform: "linux", arch: "arm64" };
  }

  async upload(localPath: string, remotePath: string): Promise<void> {
    this.uploads.push({ localPath, remotePath });
    this.remoteFiles.set(remotePath, await readFile(localPath, "utf8"));
  }

  async exec(command: string): Promise<StdioStream> {
    this.commands.push(command);

    const lockOwner = command.match(/\.holder-([\w-]+)\.sh/u)?.[1];
    if (lockOwner) {
      return createLockHolderStream(
        `zcode-deploy-lock-acquired:${lockOwner}`,
        this.lockReleaseMarkers,
        this.lockCloseCode,
        this.lockAcquireGate,
      );
    }

    const versionCommand = `"${"$HOME"}"'/.zcode/server/node' "${"$HOME"}"'/.zcode/server/zcode-server.cjs' --version`;
    if (command === versionCommand) {
      const versionSource =
        this.serverVersions.length > 1
          ? this.serverVersions.shift()!
          : (this.serverVersions[0] ?? ZCODE_VERSION);
      const version =
        typeof versionSource === "function" ? versionSource() : versionSource;
      return createClosedStream(`${version}\n`);
    }

    const matchedPlan = this.commandPlans.find((plan) =>
      plan.matcher.test(command),
    );
    if (matchedPlan) {
      matchedPlan.onExec?.();
      return createClosedStream(matchedPlan.stdoutText ?? "", {
        exitCode: matchedPlan.exitCode,
        stderrText: matchedPlan.stderrText,
      });
    }

    return createClosedStream();
  }

  async exists(remotePath: string): Promise<boolean> {
    return (
      this.remoteFiles.has(remotePath) ||
      remotePath === "~/.zcode/server/node" ||
      remotePath === "~/.zcode/server/zcode-server.cjs"
    );
  }

  async readFile(remotePath: string): Promise<string> {
    const content = this.remoteFiles.get(remotePath);
    if (content == null) {
      throw new Error(`ENOENT: ${remotePath}`);
    }
    return content;
  }
}

function createLockHolderStream(
  acquiredMarker: string,
  releaseMarkers: string[],
  closeCode = 0,
  acquireGate?: Promise<void>,
): StdioStream {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const closeListeners: Array<(code: number) => void> = [];
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    stdout.end();
    stderr.end();
    for (const listener of closeListeners) listener(closeCode);
  };
  stdin.on("data", (chunk: Buffer) =>
    releaseMarkers.push(chunk.toString().trim()),
  );
  stdin.on("end", close);
  queueMicrotask(() => {
    void (acquireGate ?? Promise.resolve()).then(() => {
      stdout.write(`${acquiredMarker}\n`);
    });
  });
  return {
    stdin,
    stdout,
    stderr,
    onClose(listener) {
      closeListeners.push(listener);
      return { dispose() {} };
    },
  };
}

function hasUploadForStagingTarget(
  backend: FakeRemoteBackend,
  stagingTarget: string,
): boolean {
  return findUploadForStagingTarget(backend, stagingTarget) !== undefined;
}

function findUploadForStagingTarget(
  backend: FakeRemoteBackend,
  stagingTarget: string,
): { localPath: string; remotePath: string } | undefined {
  return backend.uploads.find(
    (upload) =>
      upload.remotePath === stagingTarget ||
      upload.remotePath.startsWith(`${stagingTarget}-`),
  );
}

class FailFirstGlmUploadRemoteBackend extends FakeRemoteBackend {
  private shouldFailGlmUpload = true;

  override async upload(localPath: string, remotePath: string): Promise<void> {
    if (
      this.shouldFailGlmUpload &&
      (remotePath === "~/.zcode/server/agents/glm/zcode.cjs.new" ||
        remotePath.startsWith(
          "~/.zcode/server/agents/glm/zcode.cjs.new-",
        ))
    ) {
      this.shouldFailGlmUpload = false;
      throw new Error("mock glm upload failed");
    }
    await super.upload(localPath, remotePath);
  }
}

class FailFirstNodePtyInstallRemoteBackend extends FakeRemoteBackend {
  private shouldFailNodePtyInstall = true;

  override async exec(command: string): Promise<StdioStream> {
    if (
      this.shouldFailNodePtyInstall &&
      command.includes("/node-pty/") &&
      command.includes("pty.node")
    ) {
      this.shouldFailNodePtyInstall = false;
      this.commands.push(command);
      return createClosedStream("", {
        exitCode: 1,
        stderrText: "mock node-pty install failed",
      });
    }
    return super.exec(command);
  }
}

class FakeWslRemoteBackend extends FakeRemoteBackend {
  readonly kind = "wsl" as const;
}

class FakeFileOnlyExistsRemoteBackend extends FakeRemoteBackend {
  constructor(
    initialFiles: Record<string, string>,
    private readonly directoryPaths: readonly string[],
  ) {
    super(initialFiles);
  }

  override async exists(remotePath: string): Promise<boolean> {
    if (this.directoryPaths.includes(remotePath)) {
      return false;
    }
    return super.exists(remotePath);
  }
}

function createClosedStream(
  stdoutText = "",
  options: {
    exitCode?: number;
    stderrText?: string;
  } = {},
): StdioStream {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();

  const onClose: Event<number> = (
    listener: (code: number) => void,
  ): IDisposable => {
    queueMicrotask(() => {
      if (stdoutText.length > 0) {
        stdout.write(stdoutText);
      }
      stdout.end();
      if (options.stderrText) {
        stderr.write(options.stderrText);
      }
      stderr.end();
      listener(options.exitCode ?? 0);
    });

    return { dispose() {} };
  };

  return { stdin, stdout, stderr, onClose };
}

async function stageRemoteRuntimeRelease(
  rootDir: string,
  options: {
    platform: "linux" | "darwin";
    arch: "arm64" | "x64";
  } = {
    platform: "linux",
    arch: "arm64",
  },
): Promise<void> {
  const platformKey = `${options.platform}-${options.arch}`;
  const releaseDir = join(rootDir, "releases", ZCODE_VERSION);
  const nodeDir = join(releaseDir, "node", platformKey);
  const serverDir = join(releaseDir, "server");
  const nodePtyDir = join(releaseDir, "node-pty", platformKey);

  await mkdir(nodeDir, { recursive: true });
  await mkdir(serverDir, { recursive: true });
  await mkdir(nodePtyDir, { recursive: true });
  await writeFile(join(nodeDir, "node"), "node runtime", "utf8");
  await writeFile(
    join(serverDir, "zcode-server.cjs"),
    "// remote server bundle\n",
    "utf8",
  );
  await writeFile(join(nodePtyDir, "pty.node"), "node-pty prebuild", "utf8");
  if (options.platform === "darwin") {
    await writeFile(
      join(nodePtyDir, "spawn-helper"),
      "node-pty spawn helper",
      "utf8",
    );
  }

  for (const [provider, runtime] of Object.entries(
    LEGACY_REMOTE_TEST_AGENT_RUNTIME,
  )) {
    if (runtime.binaryKind === "node-script") {
      const providerDir = join(
        releaseDir,
        retiredProtocolPrefix,
        platformKey,
        runtime.bundledResourceDir,
      );
      const entryPath = join(
        providerDir,
        ...runtime.resolveEntrySegments(options.platform),
      );
      await mkdir(dirname(entryPath), { recursive: true });
      await writeFile(entryPath, `// ${provider} test entry\n`, "utf8");
      if (provider === "claude") {
        const claudeNativePath = join(
          providerDir,
          "node_modules",
          "@anthropic-ai",
          `claude-agent-sdk-${platformKey}`,
          "claude",
        );
        await mkdir(dirname(claudeNativePath), { recursive: true });
        await writeFile(claudeNativePath, "claude native binary", "utf8");
      }
      await writeFile(
        join(providerDir, ".bundle-meta.json"),
        JSON.stringify(
          {
            provider,
            version: runtime.version,
            platform: platformKey,
          },
          null,
          2,
        ),
        "utf8",
      );
      continue;
    }

    const entrySegments = runtime.resolveEntrySegments(options.platform);
    const binaryName = entrySegments[entrySegments.length - 1];
    if (!binaryName) {
      throw new Error(`Missing binary name for provider: ${provider}`);
    }

    const binaryDir = join(releaseDir, runtime.bundledResourceDir, platformKey);
    await mkdir(binaryDir, { recursive: true });
    await writeFile(join(binaryDir, binaryName), `${provider} binary`, "utf8");
    // ZCode Agent（glm）远端不再发原生二进制，而是发编译产物 zcode.cjs，
    // 由远端已部署的 node 通过 wrapper 执行，故 source release 需提供该 bundle。
    if (provider === "glm") {
      await writeFile(
        join(binaryDir, REMOTE_AGENT_BUNDLE_FILE_NAME),
        `${provider} bundle`,
        "utf8",
      );
      for (const relativePath of OFFICIAL_PLUGIN_REQUIRED_RELATIVE_PATHS) {
        await mkdir(dirname(join(binaryDir, "packages", relativePath)), {
          recursive: true,
        });
        await writeFile(
          join(binaryDir, "packages", relativePath),
          `${provider} official plugin ${relativePath}`,
          "utf8",
        );
      }
    }
  }

  for (const { runtime } of getRemoteRuntimeToolsForPlatform(options.platform)) {
    const entrySegments = runtime.resolveEntrySegments(options.platform);
    const binaryName = entrySegments[entrySegments.length - 1];
    if (!binaryName) {
      throw new Error(
        `Missing binary name for runtime tool: ${runtime.bundledResourceDir}`,
      );
    }

    const binaryDir = join(
      releaseDir,
      "tools",
      platformKey,
      runtime.bundledResourceDir,
    );
    await mkdir(binaryDir, { recursive: true });
    await writeFile(
      join(binaryDir, binaryName),
      `${runtime.bundledResourceDir} binary`,
      "utf8",
    );
  }
}

function createFullyDeployedRemoteFiles(
  platformKey: RemotePlatformKey,
): Record<string, string> {
  const [platform] = platformKey.split("-") as ["linux" | "darwin", string];
  const files: Record<string, string> = {
    "~/.zcode/server/build/Release/pty.node": "deployed node-pty",
  };
  if (platform === "darwin") {
    files["~/.zcode/server/build/Release/spawn-helper"] =
      "deployed spawn helper";
  }

  for (const [provider, runtime] of Object.entries(
    LEGACY_REMOTE_TEST_AGENT_RUNTIME,
  )) {
    const remoteProviderDir = `~/.zcode/server/agents/${runtime.bundledResourceDir}`;
    files[`${remoteProviderDir}/.version`] = `${runtime.version}\n`;
    if (runtime.binaryKind === "node-script") {
      files[`${remoteProviderDir}/.bundle-meta.json`] = JSON.stringify({
        provider,
        version: runtime.version,
        platform: platformKey,
      });
      const entryPath = runtime.resolveEntrySegments(platform).join("/");
      files[`${remoteProviderDir}/${entryPath}`] = `${provider} entry`;
      if (provider === "claude") {
        files[
          `${remoteProviderDir}/node_modules/@anthropic-ai/claude-agent-sdk-${platformKey}/claude`
        ] = "claude native binary";
      }
    } else if (provider === "glm") {
      // ZCode Agent 远端部署后：wrapper（zcode-agent）+ 编译产物 bundle（zcode.cjs）。
      const entrySegments = runtime.resolveEntrySegments(platform);
      const wrapperName = entrySegments[entrySegments.length - 1];
      if (wrapperName) {
        files[`${remoteProviderDir}/${wrapperName}`] = `${provider} wrapper`;
      }
      files[`${remoteProviderDir}/${REMOTE_AGENT_BUNDLE_FILE_NAME}`] =
        `${provider} bundle`;
      for (const relativePath of OFFICIAL_PLUGIN_REQUIRED_RELATIVE_PATHS) {
        files[`${remoteProviderDir}/packages/${relativePath}`] =
          `${provider} official plugin ${relativePath}`;
      }
    } else {
      const entrySegments = runtime.resolveEntrySegments(platform);
      const binaryName = entrySegments[entrySegments.length - 1];
      if (binaryName) {
        files[`${remoteProviderDir}/${binaryName}`] = `${provider} binary`;
      }
    }
  }

  for (const { runtime, version } of getRemoteRuntimeToolsForPlatform(platform)) {
    files[`~/.zcode/server/tools/${runtime.bundledResourceDir}/.version`] =
      `${version}\n`;
    const entrySegments = runtime.resolveEntrySegments(platform);
    const binaryName = entrySegments[entrySegments.length - 1];
    if (binaryName) {
      files[
        `~/.zcode/server/tools/${runtime.bundledResourceDir}/${binaryName}`
      ] = `${runtime.bundledResourceDir} binary`;
    }
  }

  return files;
}

function addMatchingGlmAndServerArtifactIdentities(
  remoteFiles: Record<string, string>,
  manifest: RemoteComponentManifest,
  platformKey: RemotePlatformKey,
  version = LEGACY_REMOTE_TEST_AGENT_RUNTIME.glm.version,
): void {
  addMatchingGlmArtifactIdentity(
    remoteFiles,
    manifest,
    platformKey,
    version,
  );
  addMatchingServerBundleArtifactIdentity(
    remoteFiles,
    manifest,
    platformKey,
  );
}

function addMatchingGlmArtifactIdentity(
  remoteFiles: Record<string, string>,
  manifest: RemoteComponentManifest,
  platformKey: RemotePlatformKey,
  version = LEGACY_REMOTE_TEST_AGENT_RUNTIME.glm.version,
): void {
  const glm = manifest.components.find((component) => component.id === "glm");
  if (!glm) {
    throw new Error("missing glm component in staged manifest");
  }
  remoteFiles["~/.zcode/server/.asset-components/glm.json"] = JSON.stringify({
    id: "glm",
    version,
    sha256: glm.sha256,
    platformArch: platformKey,
  });
}

function addMatchingServerBundleArtifactIdentity(
  remoteFiles: Record<string, string>,
  manifest: RemoteComponentManifest,
  platformKey: RemotePlatformKey,
): void {
  const serverBundle = findManifestComponent(manifest, "server-bundle");
  remoteFiles["~/.zcode/server/.asset-components/server-bundle.json"] =
    JSON.stringify({
      id: "server-bundle",
      version: serverBundle.version,
      sha256: serverBundle.sha256,
      platformArch: platformKey,
    });
}

function findManifestComponent(
  manifest: RemoteComponentManifest,
  componentId: string,
): RemoteComponentManifestItem {
  const component = manifest.components.find(
    (item) => item.id === componentId,
  );
  if (!component) {
    throw new Error(`missing component in staged manifest: ${componentId}`);
  }
  return component;
}

function createRemoteAssetComponentMeta(
  id: string,
  version: string,
  platformArch: RemotePlatformKey,
): string {
  return JSON.stringify({
    id,
    version,
    platformArch,
  });
}

async function writeTestOfficialPluginPackages(repoDir: string): Promise<void> {
  await Promise.all(
    OFFICIAL_PLUGIN_PACKAGE_NAMES.map(async (pluginName) => {
      const manifestPath = join(
        repoDir,
        "apps",
        "zcode-cli",
        "packages",
        pluginName,
        ".zcode-plugin",
        "plugin.json",
      );
      await mkdir(dirname(manifestPath), { recursive: true });
      const pluginManifestName =
        pluginName === "zcode-cua-plugin"
          ? "computer-use"
          : pluginName.replace(/-plugin$/u, "");
      await writeFile(
        manifestPath,
        JSON.stringify({
          name: pluginManifestName,
          version: "0.1.0",
        }),
        "utf8",
      );
      const pluginRoot = dirname(dirname(manifestPath));
      const requiredAssetPaths = OFFICIAL_PLUGIN_REQUIRED_RELATIVE_PATHS.filter(
        (relativePath) => relativePath.startsWith(`${pluginName}/`),
      )
        .map((relativePath) => relativePath.slice(pluginName.length + 1))
        .filter((relativePath) => relativePath !== ".zcode-plugin/plugin.json");
      await Promise.all(
        requiredAssetPaths.map(async (relativePath) => {
          const assetPath = join(pluginRoot, ...relativePath.split("/"));
          await mkdir(dirname(assetPath), { recursive: true });
          await writeFile(
            assetPath,
            `${pluginName} asset ${relativePath}\n`,
            "utf8",
          );
        }),
      );
    }),
  );
}

function resolveRemoteComponentCacheDirForTest(
  platformArch: RemotePlatformKey,
  componentId: string,
  componentVersion: string,
): string {
  const cacheSegment = createHash("sha256")
    .update(componentVersion)
    .digest("hex")
    .slice(0, 16);
  return `~/.zcode/server/asset-cache/components/${platformArch}/${componentId}/${cacheSegment}`;
}

async function stageRemoteAssetArchive(
  mockCdnDir: string,
  outputRoot: string,
  options?: {
    platformKey?: "linux-arm64" | "linux-x64" | "darwin-arm64" | "darwin-x64";
    useLegacyFileName?: boolean;
  },
): Promise<void> {
  const sourceReleaseDir = join(mockCdnDir, "releases", ZCODE_VERSION);
  const outputVersionDir = join(outputRoot, ZCODE_VERSION);
  const platformKey = options?.platformKey ?? "linux-arm64";
  const archiveFileName = options?.useLegacyFileName
    ? "remote-assets.tar.gz"
    : `remote-assets-${platformKey}.tar.gz`;
  const checksumFileName = options?.useLegacyFileName
    ? "remote-assets.sha256"
    : `remote-assets-${platformKey}.sha256`;
  const archivePath = join(outputVersionDir, archiveFileName);
  const checksumPath = join(outputVersionDir, checksumFileName);

  await mkdir(outputVersionDir, { recursive: true });
  await createTarGzArchive(archivePath, [
    { sourcePath: join(sourceReleaseDir, "server"), archivePath: "server" },
    {
      sourcePath: join(sourceReleaseDir, "node", platformKey),
      archivePath: `node/${platformKey}`,
    },
    {
      sourcePath: join(sourceReleaseDir, "node-pty", platformKey),
      archivePath: `node-pty/${platformKey}`,
    },
    {
      sourcePath: join(sourceReleaseDir, retiredProtocolPrefix, platformKey),
      archivePath: `${retiredProtocolPrefix}/${platformKey}`,
    },
    {
      sourcePath: join(sourceReleaseDir, "opencode", platformKey),
      archivePath: `opencode/${platformKey}`,
    },
    {
      sourcePath: join(sourceReleaseDir, "glm", platformKey),
      archivePath: `glm/${platformKey}`,
    },
    {
      sourcePath: join(sourceReleaseDir, "tools", platformKey),
      archivePath: `tools/${platformKey}`,
    },
  ]);
  const checksum = await computeSha256(archivePath);
  await writeFile(checksumPath, `${checksum}\n`, "utf8");
}

function buildRemoteComponentArtifactSpecs(
  platformKey: RemotePlatformKey,
): RemoteComponentArtifactSpec[] {
  const specs: RemoteComponentArtifactSpec[] = [
    {
      id: "server-bundle",
      version: `${ZCODE_VERSION}-server-bundle`,
      artifactPath: `components/${platformKey}/server-bundle/${ZCODE_VERSION}-server-bundle.tar.gz`,
      mount: "server",
      sourcePath: "server",
    },
    {
      id: "node-runtime",
      version: "24.10.0-node-runtime",
      artifactPath: `components/${platformKey}/node-runtime/24.10.0-node-runtime.tar.gz`,
      mount: `node/${platformKey}`,
      sourcePath: `node/${platformKey}`,
    },
    {
      id: "node-pty",
      version: "1.0.0-node-pty",
      artifactPath: `components/${platformKey}/node-pty/1.0.0-node-pty.tar.gz`,
      mount: `node-pty/${platformKey}`,
      sourcePath: `node-pty/${platformKey}`,
    },
  ];

  for (const [provider, runtime] of Object.entries(
    LEGACY_REMOTE_TEST_AGENT_RUNTIME,
  )) {
    if (runtime.binaryKind === "node-script") {
      specs.push({
        id: `${retiredProtocolPrefix}-${provider}`,
        version: `${runtime.version}-${provider}`,
        artifactPath: `components/${platformKey}/${retiredProtocolPrefix}-${provider}/${runtime.version}-${provider}.tar.gz`,
        mount: `${retiredProtocolPrefix}/${platformKey}/${runtime.bundledResourceDir}`,
        sourcePath: `${retiredProtocolPrefix}/${platformKey}/${runtime.bundledResourceDir}`,
      });
      continue;
    }

    specs.push({
      id: provider,
      version: `${runtime.version}-${provider}`,
      artifactPath: `components/${platformKey}/${provider}/${runtime.version}-${provider}.tar.gz`,
      mount: `${runtime.bundledResourceDir}/${platformKey}`,
      sourcePath: `${runtime.bundledResourceDir}/${platformKey}`,
    });
  }

  const [platform] = platformKey.split("-");
  for (const { runtime, version } of getRemoteRuntimeToolsForPlatform(platform)) {
    specs.push({
      id: runtime.bundledResourceDir,
      version: `${version}-${runtime.bundledResourceDir}`,
      artifactPath: `components/${platformKey}/${runtime.bundledResourceDir}/${version}-${runtime.bundledResourceDir}.tar.gz`,
      mount: `tools/${platformKey}/${runtime.bundledResourceDir}`,
      sourcePath: `tools/${platformKey}/${runtime.bundledResourceDir}`,
    });
  }

  // 同一 id 在 manifest 中必须唯一，避免后续组装时覆盖导致断言失真。
  const duplicatedIds = specs
    .map((spec) => spec.id)
    .filter((id, index, ids) => ids.indexOf(id) !== index);
  if (duplicatedIds.length > 0) {
    throw new Error(
      `Duplicated component ids in staged manifest: ${duplicatedIds.join(", ")}`,
    );
  }
  return specs;
}

async function copySourcePathContentToDir(
  sourcePath: string,
  targetDir: string,
): Promise<void> {
  const sourceStat = await stat(sourcePath);
  if (sourceStat.isDirectory()) {
    const children = await readdir(sourcePath);
    await Promise.all(
      children.map((child) =>
        cp(join(sourcePath, child), join(targetDir, child), {
          recursive: true,
        }),
      ),
    );
    return;
  }

  await cp(sourcePath, join(targetDir, basename(sourcePath)));
}

async function stageComponentArchive(
  sourceReleaseDir: string,
  outputRoot: string,
  spec: RemoteComponentArtifactSpec,
): Promise<string> {
  const stagingBase = join(outputRoot, ".component-staging");
  await mkdir(stagingBase, { recursive: true });
  const stagingDir = await mkdtemp(join(stagingBase, `${spec.id}-`));
  const archivePath = join(outputRoot, spec.artifactPath);

  try {
    await copySourcePathContentToDir(
      join(sourceReleaseDir, spec.sourcePath),
      stagingDir,
    );
    await mkdir(dirname(archivePath), { recursive: true });
    const stagedEntries = await readdir(stagingDir);
    await createTarGzArchive(
      archivePath,
      stagedEntries.map((entry) => ({
        sourcePath: join(stagingDir, entry),
        archivePath: entry,
      })),
    );
    return await computeSha256(archivePath);
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
}

async function stageRemoteComponentArtifacts(
  mockCdnDir: string,
  outputRoot: string,
  options?: StageRemoteComponentArtifactsOptions,
): Promise<RemoteComponentManifest> {
  const platformKey = options?.platformKey ?? "linux-arm64";
  const sourceReleaseDir = join(mockCdnDir, "releases", ZCODE_VERSION);
  const outputVersionDir = join(outputRoot, ZCODE_VERSION);
  const componentSpecs = buildRemoteComponentArtifactSpecs(platformKey);
  const components: RemoteComponentManifestItem[] = [];

  await mkdir(outputVersionDir, { recursive: true });
  for (const spec of componentSpecs) {
    const sha256 = await stageComponentArchive(
      sourceReleaseDir,
      outputRoot,
      spec,
    );
    components.push({
      id: spec.id,
      version: spec.version,
      sha256,
      artifactPath: spec.artifactPath,
      mount: spec.mount,
    });
  }

  const manifest = options?.mutateManifest
    ? options.mutateManifest({
        schemaVersion: 1,
        appVersion: ZCODE_VERSION,
        platformArch: platformKey,
        components,
      })
    : {
        schemaVersion: 1,
        appVersion: ZCODE_VERSION,
        platformArch: platformKey,
        components,
      };

  if (options?.writeManifest !== false) {
    const manifestPath = join(outputVersionDir, `manifest-${platformKey}.json`);
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  }

  return manifest;
}

async function computeSha256(filePath: string): Promise<string> {
  const content = await readFile(filePath);
  return createHash("sha256").update(content).digest("hex");
}

async function computeDevelopmentAgentAssetsSha256ForTest(
  repoDir: string,
  cliBundlePath: string,
): Promise<string> {
  const hash = createHash("sha256");
  hash.update("bundle:zcode.cjs\n");
  hash.update(await readFile(cliBundlePath));
  for (const packageName of OFFICIAL_PLUGIN_PACKAGE_NAMES) {
    const packageRoot = join(
      repoDir,
      "apps",
      "zcode-cli",
      "packages",
      packageName,
    );
    hash.update(`plugin:${packageName}\n`);
    for (const topLevelPath of OFFICIAL_PLUGIN_INCLUDED_TOP_LEVEL_PATHS) {
      const sourcePath = join(packageRoot, topLevelPath);
      try {
        await hashLocalPathForTest(
          hash,
          sourcePath,
          `${packageName}/${topLevelPath}`,
        );
      } catch {
        // 测试 fixture 只写最小 manifest，缺失的可选目录与生产逻辑一致忽略。
      }
    }
  }
  return hash.digest("hex");
}

async function hashLocalPathForTest(
  hash: ReturnType<typeof createHash>,
  filePath: string,
  relativePath: string,
): Promise<void> {
  const fileStat = await stat(filePath);
  if (fileStat.isDirectory()) {
    hash.update(`dir:${relativePath}\n`);
    const children = (await readdir(filePath)).sort((left, right) =>
      left.localeCompare(right, "en"),
    );
    for (const child of children) {
      await hashLocalPathForTest(
        hash,
        join(filePath, child),
        `${relativePath}/${child}`,
      );
    }
    return;
  }

  if (!fileStat.isFile()) {
    return;
  }

  hash.update(
    `file:${relativePath}:${fileStat.mode & 0o777}:${fileStat.size}\n`,
  );
  hash.update(await readFile(filePath));
}

async function hashFileContent(
  hash: ReturnType<typeof createHash>,
  filePath: string,
  relativePath: string,
): Promise<void> {
  const fileStat = await stat(filePath);
  hash.update(
    `file:${relativePath}:${fileStat.mode & 0o777}:${fileStat.size}\n`,
  );
  hash.update(await readFile(filePath));
}

async function hashDirectoryContent(
  hash: ReturnType<typeof createHash>,
  rootDir: string,
  relativeDir = "",
): Promise<void> {
  const entries = (await readdir(rootDir, { withFileTypes: true })).sort(
    (left, right) => left.name.localeCompare(right.name),
  );

  for (const entry of entries) {
    const entryPath = join(rootDir, entry.name);
    const entryRelativePath = relativeDir
      ? `${relativeDir}/${entry.name}`
      : entry.name;

    if (entry.isDirectory()) {
      const dirStat = await stat(entryPath);
      hash.update(`dir:${entryRelativePath}:${dirStat.mode & 0o777}\n`);
      await hashDirectoryContent(hash, entryPath, entryRelativePath);
      continue;
    }

    if (entry.isFile()) {
      await hashFileContent(hash, entryPath, entryRelativePath);
      continue;
    }

    throw new Error(`Unsupported test fixture entry: ${entryPath}`);
  }
}

async function computePathContentSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  const pathStat = await stat(path);

  if (pathStat.isDirectory()) {
    hash.update("root:dir\n");
    await hashDirectoryContent(hash, path);
  } else if (pathStat.isFile()) {
    hash.update("root:file\n");
    await hashFileContent(hash, path, "root-file");
  } else {
    throw new Error(`Unsupported test fixture path: ${path}`);
  }

  return hash.digest("hex");
}

function toVersionedArtifactRequestPath(artifactPath: string): string {
  return `/${ZCODE_VERSION}/${artifactPath}`;
}

function toComponentArtifactRequestPath(artifactPath: string): string {
  return `/${artifactPath}`;
}

async function createStaticFileServer(
  rootDir: string,
  options?: {
    stalledPaths?: string[];
    responseGates?: ReadonlyMap<string, Promise<void>>;
  },
): Promise<{
  baseUrl: string;
  close(): Promise<void>;
  getRequestCount(path: string): number;
}> {
  const requestCounts = new Map<string, number>();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const encodedRelativePath = url.pathname.replace(/^\/+/, "");
    // Bugfix: 客户端组件 URL 现在会对路径段做编码（如 + -> %2B）。
    // 测试文件路径是原始文件名，需要先 decode 再命中本地文件系统。
    const relativePath = decodeURI(encodedRelativePath);
    requestCounts.set(relativePath, (requestCounts.get(relativePath) ?? 0) + 1);

    if (options?.stalledPaths?.includes(`/${relativePath}`)) {
      res.statusCode = 200;
      res.write("{");
      return;
    }

    await options?.responseGates?.get(`/${relativePath}`);

    try {
      const content = await readFile(join(rootDir, relativePath));
      res.statusCode = 200;
      res.end(content);
    } catch {
      res.statusCode = 404;
      res.end("not found");
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
    getRequestCount(path: string) {
      return requestCounts.get(path.replace(/^\/+/, "")) ?? 0;
    },
  };
}

const tempDirs: string[] = [];
const originalCwd = process.cwd();
const originalRemoteDevAgentBundleEnv =
  process.env.ZCODE_REMOTE_DEV_AGENT_BUNDLE;
const originalZCodeRuntimeEnv = process.env[ZCODE_RUNTIME_ENV_KEY];
const DEV_CLI_BUNDLE_TEST_SUFFIX = join(
  "apps",
  "zcode-cli",
  "packages",
  "cli",
  "dist",
  "zcode.cjs",
);

afterEach(async () => {
  process.chdir(originalCwd);
  if (originalRemoteDevAgentBundleEnv === undefined) {
    delete process.env.ZCODE_REMOTE_DEV_AGENT_BUNDLE;
  } else {
    process.env.ZCODE_REMOTE_DEV_AGENT_BUNDLE = originalRemoteDevAgentBundleEnv;
  }
  if (originalZCodeRuntimeEnv === undefined) {
    delete process.env[ZCODE_RUNTIME_ENV_KEY];
  } else {
    process.env[ZCODE_RUNTIME_ENV_KEY] = originalZCodeRuntimeEnv;
  }
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })),
  );
});

describe("deployServer legacy agent node-script bundle deployment", () => {
  it("调用方已串行化部署时不创建远端 install-root lock", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-remote-deploy-"));
    tempDirs.push(rootDir);
    const mockCdnDir = join(rootDir, "mock-cdn");
    await stageRemoteRuntimeRelease(mockCdnDir);
    const manifest = await stageRemoteComponentArtifacts(
      mockCdnDir,
      join(mockCdnDir, "releases"),
    );
    const remoteFiles = createFullyDeployedRemoteFiles("linux-arm64");
    addMatchingGlmAndServerArtifactIdentities(
      remoteFiles,
      manifest,
      "linux-arm64",
    );
    const backend = new FakeRemoteBackend(remoteFiles);

    const deployed = await deployServer(
      backend,
      { platform: "linux", arch: "arm64" },
      {
        force: false,
        mockCdnDir,
        deployLockMode: "caller-serialized",
      },
    );

    expect(deployed).toBe(false);
    expect(
      backend.commands.filter((command) => command.endsWith("--version")),
    ).toHaveLength(1);
    expect(backend.commands.join("\n")).not.toContain(".deploy.lock");
    expect(backend.lockReleaseMarkers).toEqual([]);
    expect(backend.uploads).toEqual([]);
  });

  it("rechecks the server version after acquiring the install-root lock", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-remote-deploy-"));
    tempDirs.push(rootDir);
    const mockCdnDir = join(rootDir, "mock-cdn");
    await stageRemoteRuntimeRelease(mockCdnDir);
    const manifest = await stageRemoteComponentArtifacts(
      mockCdnDir,
      join(mockCdnDir, "releases"),
    );
    const remoteFiles = createFullyDeployedRemoteFiles("linux-arm64");
    addMatchingGlmAndServerArtifactIdentities(
      remoteFiles,
      manifest,
      "linux-arm64",
    );
    const backend = new FakeRemoteBackend(remoteFiles, {
      serverVersions: ["previous-version", ZCODE_VERSION],
    });

    const deployed = await deployServer(
      backend,
      { platform: "linux", arch: "arm64" },
      { force: false, mockCdnDir },
    );

    expect(deployed).toBe(false);
    expect(
      backend.commands.filter((command) => command.endsWith("--version")),
    ).toHaveLength(2);
    expect(backend.commands.join("\n")).toContain(".deploy.lock.holder-");
    expect(backend.lockReleaseMarkers[0]).toMatch(
      /^zcode-deploy-lock-release:/u,
    );
    expect(backend.uploads).toEqual([]);
  });

  it("waits for the install-root lock before pinning the deployment manifest", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-remote-deploy-"));
    tempDirs.push(rootDir);
    const mockCdnDir = join(rootDir, "mock-cdn");
    const cdnRoot = join(rootDir, "cdn");
    const remoteCacheDir = join(rootDir, "remote-cache");
    await stageRemoteRuntimeRelease(mockCdnDir);
    const manifest = await stageRemoteComponentArtifacts(mockCdnDir, cdnRoot);
    const remoteFiles = createFullyDeployedRemoteFiles("linux-arm64");
    addMatchingGlmAndServerArtifactIdentities(
      remoteFiles,
      manifest,
      "linux-arm64",
    );
    let releaseLockAcquire!: () => void;
    const lockAcquireGate = new Promise<void>((resolve) => {
      releaseLockAcquire = resolve;
    });
    const backend = new FakeRemoteBackend(remoteFiles, { lockAcquireGate });
    const cdnServer = await createStaticFileServer(cdnRoot);
    const manifestPath = `/${ZCODE_VERSION}/manifest-linux-arm64.json`;

    try {
      const deployPromise = deployServer(
        backend,
        { platform: "linux", arch: "arm64" },
        { remoteCdnBaseUrl: cdnServer.baseUrl, remoteCacheDir },
      );
      await vi.waitFor(() => {
        expect(
          backend.commands.some((command) => command.includes(".deploy.lock")),
        ).toBe(true);
      });

      // Bugfix：deploy lock 等待期间不能提前固定可能过期的 manifest；
      // manifest deadline 必须从本次 owner 真正获锁后开始参与部署事务。
      expect(cdnServer.getRequestCount(manifestPath)).toBe(0);

      releaseLockAcquire();
      await expect(deployPromise).resolves.toBe(false);
      expect(cdnServer.getRequestCount(manifestPath)).toBe(1);
    } finally {
      releaseLockAcquire();
      await cdnServer.close();
    }
  });

  it("部署与 lock release 同时失败时应保留两个错误", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-remote-deploy-"));
    tempDirs.push(rootDir);
    const backend = new FakeRemoteBackend({}, { lockCloseCode: 91 });

    let caught: unknown;
    try {
      await deployServer(
        backend,
        { platform: "linux", arch: "arm64" },
        { force: true, mockCdnDir: join(rootDir, "missing-cdn") },
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AggregateError);
    const errors = (caught as AggregateError).errors as unknown[];
    expect(errors).toHaveLength(2);
    expect(String(errors[0])).toMatch(/release|missing|ENOENT/iu);
    expect(String(errors[1])).toContain("lock-holder release failed (code=91)");
  });

  it("node-runtime 已安装语义版本时应忽略 expectedVersion 的内容 hash 后缀", async () => {
    const backend = new FakeRemoteBackend({
      "~/.zcode/server/node": "node",
      "~/.zcode/server/.asset-components/node-runtime.json":
        '{"id":"node-runtime","version":"v22.16.0+aaaaaaaaaaaa","platformArch":"linux-arm64"}\n',
    });
    const installed: string[] = [];
    const installer: RemoteAssetInstaller = {
      mode: "remote-download",
      async installFile(params) {
        installed.push(params.componentId);
      },
      async installDirectory() {
        throw new Error("installDirectory should not be called");
      },
    };

    await deployNodeRuntime(
      backend,
      {
        platformArch: "linux-arm64",
        installer,
        expectedVersion: "v22.16.0+bbbbbbbbbbbb",
      },
      { log: () => undefined, logWarn: () => undefined },
    );

    expect(installed).toEqual([]);
  });

  it("旧 proxy runtime 资源选择应被忽略且不部署 proxy runtime", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-remote-deploy-"));
    tempDirs.push(rootDir);
    const mockCdnDir = join(rootDir, "mock-cdn");
    await stageRemoteRuntimeRelease(mockCdnDir);
    await mkdir(mockCdnDir, { recursive: true });
    const backend = new FakeRemoteBackend();

    const deployed = await deployServer(
      backend,
      { platform: "linux", arch: "arm64" },
      {
        force: false,
        mockCdnDir,
        resourcePackages: {
          selectedPackageIds: [retiredProxyRuntimeId],
        },
      },
    );

    expect(deployed).toBe(false);
    expect(
      hasUploadForStagingTarget(
        backend,
        "~/.zcode/server/agents/glm/zcode.cjs.new",
      ),
    ).toBe(true);
    expect(
      backend.uploads.some(
        (upload) =>
          upload.remotePath ===
          `~/.zcode/server/${retiredProxyRuntimeId}.tar.gz`,
      ),
    ).toBe(false);
    expect(
      backend.commands.some((command) =>
        command.includes(retiredProxyRuntimeId),
      ),
    ).toBe(false);
  });

  it("server 版本相同但远端缺少 node-pty 时应补传", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-remote-deploy-"));
    tempDirs.push(rootDir);
    const mockCdnDir = join(rootDir, "mock-cdn");
    await stageRemoteRuntimeRelease(mockCdnDir);
    await mkdir(mockCdnDir, { recursive: true });
    const backend = new FakeRemoteBackend();

    const deployed = await deployServer(
      backend,
      { platform: "linux", arch: "arm64" },
      {
        force: false,
        mockCdnDir,
      },
    );

    expect(deployed).toBe(false);
    expect(
      hasUploadForStagingTarget(
        backend,
        "~/.zcode/server/build/Release/pty.node.new",
      ),
    ).toBe(true);
  });

  it("server 版本相同但远端主 server 缺少 sync channel 时应补传主 server", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-remote-deploy-"));
    tempDirs.push(rootDir);
    const mockCdnDir = join(rootDir, "mock-cdn");
    await stageRemoteRuntimeRelease(mockCdnDir);
    const backend = new FakeRemoteBackend(
      createFullyDeployedRemoteFiles("linux-arm64"),
      {
        commandPlans: [
          {
            matcher: /skill-sync/u,
            exitCode: 2,
            stderrText: "missing required server bundle markers: skill-sync\n",
          },
        ],
      },
    );

    const deployed = await deployServer(
      backend,
      { platform: "linux", arch: "arm64" },
      {
        force: false,
        mockCdnDir,
      },
    );

    expect(deployed).toBe(true);
    expect(
      hasUploadForStagingTarget(
        backend,
        "~/.zcode/server/zcode-server.cjs.new",
      ),
    ).toBe(true);
    expect(backend.commands.join("\n")).toContain("skill-sync");
    expect(backend.commands.join("\n")).toContain("mcp-sync");
    expect(backend.commands.join("\n")).toContain("plugin-sync");
    expect(backend.commands.join("\n")).toContain(
      "exportMarketplaceSourceArchive",
    );
    expect(backend.commands.join("\n")).toContain(
      "importMarketplaceSourceArchive",
    );
    expect(backend.commands.join("\n")).toContain(
      "__zcode_rpc_nested_uint8array_v1",
    );
  });

  it("忽略历史资源包选择并部署完整默认远端资源", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-remote-deploy-"));
    tempDirs.push(rootDir);
    const mockCdnDir = join(rootDir, "mock-cdn");
    await stageRemoteRuntimeRelease(mockCdnDir);
    await mkdir(mockCdnDir, { recursive: true });
    const backend = new FakeRemoteBackend();

    const deployed = await deployServer(
      backend,
      { platform: "linux", arch: "arm64" },
      {
        force: false,
        mockCdnDir,
        resourcePackages: {
          selectedPackageIds: ["server-bundle", "node-runtime", "glm"],
        },
      },
    );

    expect(deployed).toBe(false);
    expect(
      hasUploadForStagingTarget(
        backend,
        "~/.zcode/server/agents/glm/zcode.cjs.new",
      ),
    ).toBe(true);
    expect(
      backend.uploads.some((upload) =>
        upload.remotePath.includes(`/${retiredProtocolPrefix}/codex`),
      ),
    ).toBe(false);
    expect(
      hasUploadForStagingTarget(
        backend,
        "~/.zcode/server/build/Release/pty.node.new",
      ),
    ).toBe(true);
    expect(
      backend.uploads.some(
        (upload) =>
          upload.remotePath ===
          `~/.zcode/server/${retiredProxyRuntimeId}.tar.gz`,
      ),
    ).toBe(false);
    expect(
      hasUploadForStagingTarget(
        backend,
        "~/.zcode/server/tools/bfs/bfs.new",
      ),
    ).toBe(true);
    expect(
      hasUploadForStagingTarget(
        backend,
        "~/.zcode/server/tools/ripgrep/rg.new",
      ),
    ).toBe(true);
    expect(
      hasUploadForStagingTarget(
        backend,
        "~/.zcode/server/tools/ugrep/ugrep.new",
      ),
    ).toBe(true);
  });

  it("darwin server 版本相同但远端缺少 spawn-helper 时应补传", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-remote-deploy-"));
    tempDirs.push(rootDir);
    const mockCdnDir = join(rootDir, "mock-cdn");
    await stageRemoteRuntimeRelease(mockCdnDir, {
      platform: "darwin",
      arch: "arm64",
    });
    await mkdir(mockCdnDir, { recursive: true });
    const backend = new FakeRemoteBackend();

    const deployed = await deployServer(
      backend,
      { platform: "darwin", arch: "arm64" },
      {
        force: false,
        mockCdnDir,
      },
    );

    expect(deployed).toBe(false);
    expect(
      hasUploadForStagingTarget(
        backend,
        "~/.zcode/server/build/Release/spawn-helper.new",
      ),
    ).toBe(true);
    expect(
      backend.uploads.some((upload) =>
        upload.remotePath.includes("~/.zcode/server/tools/bfs/"),
      ),
    ).toBe(false);
    expect(
      backend.uploads.some((upload) =>
        upload.remotePath.includes("~/.zcode/server/tools/ugrep/"),
      ),
    ).toBe(false);
  });

  it("旧 codex 资源选择应被忽略，不再重新部署 codex", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-remote-deploy-"));
    tempDirs.push(rootDir);
    const mockCdnDir = join(rootDir, "mock-cdn");
    await stageRemoteRuntimeRelease(mockCdnDir);
    await mkdir(mockCdnDir, { recursive: true });

    const backend = new FakeRemoteBackend({
      "~/.zcode/server/agents/codex/.version": `${LEGACY_REMOTE_TEST_AGENT_RUNTIME.codex.version}\n`,
      "~/.zcode/server/agents/codex/.bundle-meta.json": JSON.stringify({
        provider: "codex",
        version: LEGACY_REMOTE_TEST_AGENT_RUNTIME.codex.version,
        platform: "darwin-arm64",
      }),
    });

    const deployed = await deployServer(
      backend,
      { platform: "linux", arch: "arm64" },
      {
        force: false,
        mockCdnDir,
        resourcePackages: {
          selectedPackageIds: [`${retiredProtocolPrefix}-codex`, "ripgrep"],
        },
      },
    );

    expect(deployed).toBe(false);
    expect(
      backend.uploads.some(
        (upload) => upload.remotePath === "~/.zcode/server/agents/codex.tar.gz",
      ),
    ).toBe(false);
    expect(
      hasUploadForStagingTarget(
        backend,
        "~/.zcode/server/agents/glm/zcode.cjs.new",
      ),
    ).toBe(true);
    expect(
      hasUploadForStagingTarget(
        backend,
        "~/.zcode/server/tools/ripgrep/rg.new",
      ),
    ).toBe(true);
  });

  it("版本和 bundle meta 都匹配时应跳过 codex 重新部署", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-remote-deploy-"));
    tempDirs.push(rootDir);
    const mockCdnDir = join(rootDir, "mock-cdn");
    await stageRemoteRuntimeRelease(mockCdnDir);
    await mkdir(mockCdnDir, { recursive: true });

    const matchingMeta = JSON.stringify({
      provider: "codex",
      version: LEGACY_REMOTE_TEST_AGENT_RUNTIME.codex.version,
      platform: "linux-arm64",
    });
    const backend = new FakeRemoteBackend({
      "~/.zcode/server/agents/codex/.version": `${LEGACY_REMOTE_TEST_AGENT_RUNTIME.codex.version}\n`,
      "~/.zcode/server/agents/codex/.bundle-meta.json": matchingMeta,
      [`~/.zcode/server/agents/codex/node_modules/@zed-industries/codex-${retiredProtocolPrefix}/bin/codex-${retiredProtocolPrefix}.js`]:
        "codex entry",
      "~/.zcode/server/tools/ripgrep/.version": "v14.1.1-1\n",
      "~/.zcode/server/tools/ripgrep/rg": "ripgrep binary",
    });

    const deployed = await deployServer(
      backend,
      { platform: "linux", arch: "arm64" },
      {
        force: false,
        mockCdnDir,
        resourcePackages: {
          selectedPackageIds: [`${retiredProtocolPrefix}-codex`, "ripgrep"],
        },
      },
    );

    expect(deployed).toBe(false);
    expect(
      backend.uploads.some(
        (upload) => upload.remotePath === "~/.zcode/server/agents/codex.tar.gz",
      ),
    ).toBe(false);
    expect(
      backend.uploads.some(
        (upload) =>
          upload.remotePath === "~/.zcode/server/tools/ripgrep/rg.new",
      ),
    ).toBe(false);
  });

  it("darwin-arm64 版本和 bundle meta 匹配时应跳过 codex 重新部署", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-remote-deploy-"));
    tempDirs.push(rootDir);
    const mockCdnDir = join(rootDir, "mock-cdn");
    await stageRemoteRuntimeRelease(mockCdnDir, {
      platform: "darwin",
      arch: "arm64",
    });
    await mkdir(mockCdnDir, { recursive: true });

    const matchingMeta = JSON.stringify({
      provider: "codex",
      version: LEGACY_REMOTE_TEST_AGENT_RUNTIME.codex.version,
      platform: "darwin-arm64",
    });
    const backend = new FakeRemoteBackend({
      "~/.zcode/server/agents/codex/.version": `${LEGACY_REMOTE_TEST_AGENT_RUNTIME.codex.version}\n`,
      "~/.zcode/server/agents/codex/.bundle-meta.json": matchingMeta,
      [`~/.zcode/server/agents/codex/node_modules/@zed-industries/codex-${retiredProtocolPrefix}/bin/codex-${retiredProtocolPrefix}.js`]:
        "codex entry",
      "~/.zcode/server/tools/ripgrep/.version": "v13.0.0-10\n",
      "~/.zcode/server/tools/ripgrep/rg": "ripgrep binary",
    });

    const deployed = await deployServer(
      backend,
      { platform: "darwin", arch: "arm64" },
      {
        force: false,
        mockCdnDir,
        resourcePackages: {
          selectedPackageIds: [`${retiredProtocolPrefix}-codex`, "ripgrep"],
        },
      },
    );

    expect(deployed).toBe(false);
    expect(
      backend.uploads.some(
        (upload) => upload.remotePath === "~/.zcode/server/agents/codex.tar.gz",
      ),
    ).toBe(false);
    expect(
      backend.uploads.some(
        (upload) =>
          upload.remotePath === "~/.zcode/server/tools/ripgrep/rg.new",
      ),
    ).toBe(false);
  });

  it("claude 0.29.2 版本和 bundle meta 匹配时不要求 native binary", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-remote-deploy-"));
    tempDirs.push(rootDir);
    const mockCdnDir = join(rootDir, "mock-cdn");
    await stageRemoteRuntimeRelease(mockCdnDir, {
      platform: "linux",
      arch: "x64",
    });
    await mkdir(mockCdnDir, { recursive: true });

    const matchingMeta = JSON.stringify({
      provider: "claude",
      version: LEGACY_REMOTE_TEST_AGENT_RUNTIME.claude.version,
      platform: "linux-x64",
    });
    const backend = new FakeRemoteBackend({
      [`~/.zcode/server/agents/${retiredProtocolPrefix}/.version`]: `${LEGACY_REMOTE_TEST_AGENT_RUNTIME.claude.version}\n`,
      [`~/.zcode/server/agents/${retiredProtocolPrefix}/.bundle-meta.json`]:
        matchingMeta,
      [`~/.zcode/server/agents/${retiredProtocolPrefix}/dist/index.js`]:
        "claude entry",
    });

    const deployed = await deployServer(
      backend,
      { platform: "linux", arch: "x64" },
      {
        force: false,
        mockCdnDir,
        resourcePackages: {
          selectedPackageIds: [`${retiredProtocolPrefix}-claude`],
        },
      },
    );

    expect(deployed).toBe(false);
    expect(
      backend.uploads.some(
        (upload) =>
          upload.remotePath ===
          `~/.zcode/server/agents/${retiredProtocolPrefix}.tar.gz`,
      ),
    ).toBe(false);
  });

  it("旧 claude 资源选择应被忽略，不再因 patch fingerprint 重新部署 claude", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-remote-deploy-"));
    tempDirs.push(rootDir);
    const mockCdnDir = join(rootDir, "mock-cdn");
    await stageRemoteRuntimeRelease(mockCdnDir, {
      platform: "linux",
      arch: "x64",
    });

    const localProviderDir = join(
      mockCdnDir,
      "releases",
      ZCODE_VERSION,
      retiredProtocolPrefix,
      "linux-x64",
      LEGACY_REMOTE_TEST_AGENT_RUNTIME.claude.bundledResourceDir,
    );
    await writeFile(
      join(localProviderDir, ".bundle-meta.json"),
      JSON.stringify(
        {
          provider: "claude",
          version: LEGACY_REMOTE_TEST_AGENT_RUNTIME.claude.version,
          platform: "linux-x64",
          patchFingerprint: "patch-new",
        },
        null,
        2,
      ),
      "utf8",
    );

    const backend = new FakeRemoteBackend({
      [`~/.zcode/server/agents/${retiredProtocolPrefix}/.version`]: `${LEGACY_REMOTE_TEST_AGENT_RUNTIME.claude.version}\n`,
      [`~/.zcode/server/agents/${retiredProtocolPrefix}/.bundle-meta.json`]:
        JSON.stringify({
          provider: "claude",
          version: LEGACY_REMOTE_TEST_AGENT_RUNTIME.claude.version,
          platform: "linux-x64",
          patchFingerprint: "patch-old",
        }),
      [`~/.zcode/server/agents/${retiredProtocolPrefix}/dist/index.js`]:
        "claude entry",
    });

    const deployed = await deployServer(
      backend,
      { platform: "linux", arch: "x64" },
      {
        force: false,
        mockCdnDir,
        resourcePackages: {
          selectedPackageIds: [`${retiredProtocolPrefix}-claude`],
        },
      },
    );

    expect(deployed).toBe(false);
    expect(
      backend.uploads.some(
        (upload) =>
          upload.remotePath ===
          `~/.zcode/server/agents/${retiredProtocolPrefix}.tar.gz`,
      ),
    ).toBe(false);
    expect(
      hasUploadForStagingTarget(
        backend,
        "~/.zcode/server/agents/glm/zcode.cjs.new",
      ),
    ).toBe(true);
  });

  it("默认部署只处理 ZCode Agent，旧 node-script meta 不再阻断", async () => {
    const backend = new FakeRemoteBackend();
    const installedFiles: string[] = [];
    const installedDirectories: Array<{
      componentId: string;
      remoteDir: string;
      sourceRelativePath: string;
    }> = [];
    const installer: RemoteAssetInstaller = {
      mode: "remote-download",
      async installFile({ componentId, remotePath }) {
        installedFiles.push(`${componentId}:${remotePath}`);
      },
      async installDirectory({ componentId, remoteDir, sourceRelativePath }) {
        installedDirectories.push({
          componentId,
          remoteDir,
          sourceRelativePath,
        });
      },
    };

    await deployZCodeAgentRuntime(
      backend,
      { platform: "linux", arch: "arm64" },
      {
        platformArch: "linux-arm64",
        installer,
      },
      { log: () => undefined, logWarn: () => undefined },
    );

    expect(installedFiles).toEqual([
      "glm:~/.zcode/server/agents/glm/zcode.cjs",
    ]);
    expect(installedDirectories).toEqual([
      {
        componentId: "glm",
        remoteDir: "~/.zcode/server/agents/glm/packages",
        sourceRelativePath: "glm/linux-arm64/packages",
      },
    ]);
    expect(
      backend.uploads.some(
        (upload) =>
          upload.remotePath === "~/.zcode/server/agents/glm/zcode-agent.new",
      ),
    ).toBe(false);

    expect(
      backend.commands.some(
        (command) =>
          command.includes(
            `/.zcode/server/agents/${retiredProtocolPrefix}/.version`,
          ) &&
          command.includes(LEGACY_REMOTE_TEST_AGENT_RUNTIME.claude.version),
      ),
    ).toBe(false);
  });

  it("强制部署 ZCode Agent 时应要求 installer 刷新 glm 缓存", async () => {
    const backend = new FakeRemoteBackend();
    const installRequests: Array<{
      componentId: string;
      forceRefresh?: boolean;
      kind: "directory" | "file";
    }> = [];
    const installer: RemoteAssetInstaller = {
      mode: "remote-download",
      async installFile({ componentId, forceRefresh }) {
        installRequests.push({ componentId, forceRefresh, kind: "file" });
      },
      async installDirectory({ componentId, forceRefresh }) {
        installRequests.push({ componentId, forceRefresh, kind: "directory" });
      },
    };

    await deployZCodeAgentRuntime(
      backend,
      { platform: "linux", arch: "arm64" },
      {
        platformArch: "linux-arm64",
        installer,
        force: true,
      },
      { log: () => undefined, logWarn: () => undefined },
    );

    expect(installRequests).toEqual([
      { componentId: "glm", forceRefresh: true, kind: "file" },
      { componentId: "glm", forceRefresh: true, kind: "directory" },
    ]);
  });

  it("WSL 部署 ZCode Agent wrapper 时应走上传避免 shell 提前展开", async () => {
    const backend = new FakeWslRemoteBackend();
    const installedFiles: string[] = [];
    const installedDirectories: string[] = [];
    const installer: RemoteAssetInstaller = {
      mode: "remote-download",
      async installFile({ componentId, remotePath }) {
        installedFiles.push(`${componentId}:${remotePath}`);
      },
      async installDirectory({ componentId, remoteDir }) {
        installedDirectories.push(`${componentId}:${remoteDir}`);
      },
    };

    await deployZCodeAgentRuntime(
      backend,
      { platform: "linux", arch: "arm64" },
      {
        platformArch: "linux-arm64",
        installer,
      },
      { log: () => undefined, logWarn: () => undefined },
    );

    const wrapperTempPath = `~/.zcode/server/agents/glm/${REMOTE_AGENT_WRAPPER_FILE_NAME}.new`;
    expect(backend.uploads.map((upload) => upload.remotePath)).toContain(
      wrapperTempPath,
    );
    expect(backend.remoteFiles.get(wrapperTempPath)).toBe(
      buildRemoteAgentBundleWrapper("glm"),
    );
    expect(backend.remoteFiles.get(wrapperTempPath)).toContain(
      '"$runtime_root/node"',
    );
    expect(installedDirectories).toEqual([
      "glm:~/.zcode/server/agents/glm/packages",
    ]);
    expect(
      backend.commands.some(
        (command) =>
          command.includes(`printf %s`) &&
          command.includes(REMOTE_AGENT_WRAPPER_FILE_NAME),
      ),
    ).toBe(false);
  });

  it("WSL 已有坏 wrapper 时即使版本匹配也应重写", async () => {
    const remoteFiles = createFullyDeployedRemoteFiles("linux-arm64");
    remoteFiles[
      `~/.zcode/server/agents/glm/${REMOTE_AGENT_WRAPPER_FILE_NAME}`
    ] =
      '#!/bin/sh\nset -eu\nruntime_root="/home/dev/.zcode/server"\nexec "/node" "/home/dev/.zcode/server/agents/glm/zcode.cjs" ""\n';
    const backend = new FakeWslRemoteBackend(remoteFiles);
    const installedFiles: string[] = [];
    const installedDirectories: string[] = [];
    const installer: RemoteAssetInstaller = {
      mode: "remote-download",
      async installFile({ componentId, remotePath }) {
        installedFiles.push(`${componentId}:${remotePath}`);
      },
      async installDirectory({ componentId, remoteDir }) {
        installedDirectories.push(`${componentId}:${remoteDir}`);
      },
    };

    await deployZCodeAgentRuntime(
      backend,
      { platform: "linux", arch: "arm64" },
      {
        platformArch: "linux-arm64",
        installer,
      },
      { log: () => undefined, logWarn: () => undefined },
    );

    expect(installedFiles).toEqual([
      "glm:~/.zcode/server/agents/glm/zcode.cjs",
    ]);
    expect(backend.uploads.map((upload) => upload.remotePath)).toContain(
      `~/.zcode/server/agents/glm/${REMOTE_AGENT_WRAPPER_FILE_NAME}.new`,
    );
    expect(installedDirectories).toEqual([
      "glm:~/.zcode/server/agents/glm/packages",
    ]);
  });

  it("ZCode Agent 版本匹配但远端缺 builtin plugin 资产时应复用 cache 补部署 packages", async () => {
    const remoteOfficialPluginDir = "~/.zcode/server/agents/glm/packages";
    const remoteFiles = createFullyDeployedRemoteFiles("linux-arm64");
    remoteFiles[remoteOfficialPluginDir] = "directory marker";
    delete remoteFiles[
      "~/.zcode/server/agents/glm/packages/skill-creator-plugin/.zcode-plugin/plugin.json"
    ];
    // SSH / Docker backend 的 exists 契约只检查普通文件，目录即使存在也会返回 false。
    const backend = new FakeFileOnlyExistsRemoteBackend(remoteFiles, [
      remoteOfficialPluginDir,
    ]);
    const installRequests: Array<{
      componentId: string;
      forceRefresh?: boolean;
      kind: "directory" | "file";
      remotePath?: string;
      remoteDir?: string;
    }> = [];
    const installer: RemoteAssetInstaller = {
      mode: "remote-download",
      async installFile({ componentId, forceRefresh, remotePath }) {
        installRequests.push({
          componentId,
          forceRefresh,
          kind: "file",
          remotePath,
        });
      },
      async installDirectory({ componentId, forceRefresh, remoteDir }) {
        installRequests.push({
          componentId,
          forceRefresh,
          kind: "directory",
          remoteDir,
        });
      },
    };

    await deployZCodeAgentRuntime(
      backend,
      { platform: "linux", arch: "arm64" },
      {
        platformArch: "linux-arm64",
        installer,
      },
      { log: () => undefined, logWarn: () => undefined },
    );

    expect(installRequests).toEqual([
      {
        componentId: "glm",
        forceRefresh: false,
        kind: "file",
        remotePath: "~/.zcode/server/agents/glm/zcode.cjs",
      },
      {
        componentId: "glm",
        forceRefresh: false,
        kind: "directory",
        remoteDir: "~/.zcode/server/agents/glm/packages",
      },
    ]);
    const permissionRepairCommand = backend.commands.find((command) =>
      command.includes("command chmod -R u+rwX"),
    );
    expect(permissionRepairCommand).toEqual(
      expect.stringContaining("if [ -d "),
    );
    expect(permissionRepairCommand).toContain(
      "/.zcode/server/agents/glm/packages",
    );
    expect(permissionRepairCommand).not.toContain("/.zcode/plugins");
  });

  it("GLM 制品 hash 和 builtin plugin 资产都匹配时不应修复权限", async () => {
    const remoteFiles = createFullyDeployedRemoteFiles("linux-arm64");
    remoteFiles["~/.zcode/server/agents/glm/.version"] = "旧版本标签\n";
    remoteFiles["~/.zcode/server/.asset-components/glm.json"] = JSON.stringify({
      id: "glm",
      version: "旧版本标签",
      sha256: TEST_GLM_ARTIFACT_SHA256,
      platformArch: "linux-arm64",
    });
    const backend = new FakeRemoteBackend(remoteFiles);
    const installRequests: string[] = [];
    const installer: RemoteAssetInstaller = {
      mode: "remote-download",
      async resolveComponentSha256() {
        return TEST_GLM_ARTIFACT_SHA256;
      },
      async installFile({ componentId, remotePath }) {
        installRequests.push(`${componentId}:file:${remotePath}`);
      },
      async installDirectory({ componentId, remoteDir }) {
        installRequests.push(`${componentId}:directory:${remoteDir}`);
      },
    };

    await deployZCodeAgentRuntime(
      backend,
      { platform: "linux", arch: "arm64" },
      {
        platformArch: "linux-arm64",
        installer,
      },
      { log: () => undefined, logWarn: () => undefined },
    );

    expect(installRequests).toEqual([]);
    expect(
      backend.commands.some((command) =>
        command.includes("command chmod -R u+rwX"),
      ),
    ).toBe(false);
  });

  it("GLM 版本相同但制品 hash 变化时应重新部署并修复旧目录权限", async () => {
    const remoteFiles = createFullyDeployedRemoteFiles("linux-arm64");
    remoteFiles["~/.zcode/server/.asset-components/glm.json"] = JSON.stringify({
      id: "glm",
      version: ZCODE_AGENT_RUNTIME.version,
      sha256: "b".repeat(64),
      platformArch: "linux-arm64",
    });
    const backend = new FakeRemoteBackend(remoteFiles);
    const installRequests: Array<{
      componentId: string;
      forceRefresh?: boolean;
      kind: "directory" | "file";
      remotePath?: string;
      remoteDir?: string;
    }> = [];
    const installer: RemoteAssetInstaller = {
      mode: "remote-download",
      async resolveComponentSha256() {
        return TEST_GLM_ARTIFACT_SHA256;
      },
      async installFile({ componentId, forceRefresh, remotePath }) {
        installRequests.push({
          componentId,
          forceRefresh,
          kind: "file",
          remotePath,
        });
      },
      async installDirectory({ componentId, forceRefresh, remoteDir }) {
        expect(
          backend.commands.some((command) =>
            command.includes("command chmod -R u+rwX"),
          ),
        ).toBe(true);
        installRequests.push({
          componentId,
          forceRefresh,
          kind: "directory",
          remoteDir,
        });
      },
    };

    await deployZCodeAgentRuntime(
      backend,
      { platform: "linux", arch: "arm64" },
      {
        platformArch: "linux-arm64",
        installer,
      },
      { log: () => undefined, logWarn: () => undefined },
    );

    const permissionRepairCommandIndex = backend.commands.findIndex((command) =>
      command.includes("command chmod -R u+rwX"),
    );
    expect(permissionRepairCommandIndex).toBeGreaterThanOrEqual(0);
    expect(backend.commands[permissionRepairCommandIndex]).toContain(
      "/.zcode/server/agents/glm/packages",
    );
    expect(installRequests).toEqual([
      {
        componentId: "glm",
        forceRefresh: false,
        kind: "file",
        remotePath: "~/.zcode/server/agents/glm/zcode.cjs",
      },
      {
        componentId: "glm",
        forceRefresh: false,
        kind: "directory",
        remoteDir: "~/.zcode/server/agents/glm/packages",
      },
    ]);
  });

  it("ZCode Agent 升级时权限修复失败仍应尝试替换 packages", async () => {
    const remoteFiles = createFullyDeployedRemoteFiles("linux-arm64");
    remoteFiles["~/.zcode/server/agents/glm/.version"] = "3.3.3\n";
    const backend = new FakeRemoteBackend(remoteFiles, {
      commandPlans: [
        {
          matcher: /command chmod -R u\+rwX/u,
          exitCode: 1,
          stderrText: "chmod: permission denied",
        },
      ],
    });
    const installRequests: string[] = [];
    const installer: RemoteAssetInstaller = {
      mode: "remote-download",
      async installFile({ componentId, remotePath }) {
        installRequests.push(`${componentId}:file:${remotePath}`);
      },
      async installDirectory({ componentId, remoteDir }) {
        installRequests.push(`${componentId}:directory:${remoteDir}`);
      },
    };
    const warnings: string[] = [];

    await deployZCodeAgentRuntime(
      backend,
      { platform: "linux", arch: "arm64" },
      {
        platformArch: "linux-arm64",
        installer,
      },
      { log: () => undefined, logWarn: (message) => warnings.push(message) },
    );

    expect(
      warnings.some((message) =>
        message.includes("修复旧 builtin plugin 目录权限失败"),
      ),
    ).toBe(true);
    expect(installRequests).toEqual([
      "glm:directory:~/.zcode/server/agents/glm/packages",
      "glm:file:~/.zcode/server/agents/glm/zcode.cjs",
    ]);
  });

  it("ZCode Agent 升级时 chmod 失败后 packages 替换失败不应继续更新 bundle", async () => {
    const remoteFiles = createFullyDeployedRemoteFiles("linux-arm64");
    remoteFiles["~/.zcode/server/agents/glm/.version"] = "3.3.3\n";
    const backend = new FakeRemoteBackend(remoteFiles, {
      commandPlans: [
        {
          matcher: /command chmod -R u\+rwX/u,
          exitCode: 1,
          stderrText: "chmod: permission denied",
        },
      ],
    });
    const installRequests: string[] = [];
    const installer: RemoteAssetInstaller = {
      mode: "remote-download",
      async installFile({ componentId, remotePath }) {
        installRequests.push(`${componentId}:file:${remotePath}`);
      },
      async installDirectory({ componentId, remoteDir }) {
        installRequests.push(`${componentId}:directory:${remoteDir}`);
        throw new Error("packages replace failed");
      },
    };

    await expect(
      deployZCodeAgentRuntime(
        backend,
        { platform: "linux", arch: "arm64" },
        {
          platformArch: "linux-arm64",
          installer,
        },
        { log: () => undefined, logWarn: () => undefined },
      ),
    ).rejects.toThrow("packages replace failed");

    expect(installRequests).toEqual([
      "glm:directory:~/.zcode/server/agents/glm/packages",
    ]);
  });

  it("开发态官方插件资产必须包含 Browser client、effective docs 与 document judge agent", () => {
    // 回归原因：开发态远程上传曾漏掉 scripts，node_repl 能启动但首次 Browser bootstrap 必然导入失败。
    expect(REMOTE_AGENT_OFFICIAL_PLUGIN_INCLUDED_TOP_LEVEL_PATHS).toEqual(
      expect.arrayContaining(["agents", "dist", "docs", "scripts", "skills"]),
    );
    expect(REMOTE_AGENT_OFFICIAL_PLUGIN_REQUIRED_RELATIVE_PATHS).toEqual(
      expect.arrayContaining([
        ...BROWSER_USE_REQUIRED_RELATIVE_PATHS,
        "image-search-plugin/.mcp.json",
        "documents-plugin/agents/visual-judge.md",
        "documents-plugin/skills/docx/SKILL.md",
        "pdf-plugin/agents/visual-judge.md",
        "pdf-plugin/skills/pdf/SKILL.md",
        "presentations-plugin/agents/visual-judge.md",
        "presentations-plugin/skills/pptx/SKILL.md",
        "spreadsheets-plugin/agents/visual-judge.md",
        "spreadsheets-plugin/skills/xlsx/SKILL.md",
      ]),
    );
  });

  it("开发态缺少 Browser client 时应在上传前拒绝残缺插件", async () => {
    const rootDir = await mkdtemp(
      join(tmpdir(), "zcode-remote-dev-agent-missing-browser-client-"),
    );
    tempDirs.push(rootDir);
    const repoDir = join(rootDir, "z-code");
    const cliBundlePath = join(
      repoDir,
      "apps",
      "zcode-cli",
      "packages",
      "cli",
      "dist",
      "zcode.cjs",
    );
    await mkdir(dirname(cliBundlePath), { recursive: true });
    await writeFile(cliBundlePath, "console.log('dev zcode agent');\n", "utf8");
    await writeTestOfficialPluginPackages(repoDir);
    await rm(
      join(
        repoDir,
        "apps",
        "zcode-cli",
        "packages",
        "browser-use-plugin",
        "scripts",
        "browser-client.mjs",
      ),
    );
    process.chdir(repoDir);
    process.env.ZCODE_REMOTE_DEV_AGENT_BUNDLE = "1";
    process.env[ZCODE_RUNTIME_ENV_KEY] = "development";

    const backend = new FakeRemoteBackend();
    const installer: RemoteAssetInstaller = {
      mode: "remote-download",
      async installFile() {
        throw new Error("installFile should not be called");
      },
      async installDirectory() {
        throw new Error("installDirectory should not be called");
      },
    };

    await expect(
      deployZCodeAgentRuntime(
        backend,
        { platform: "linux", arch: "arm64" },
        {
          platformArch: "linux-arm64",
          installer,
          selectedResourcePackageIds: ["glm"],
        },
        { log: () => undefined, logWarn: () => undefined },
      ),
    ).rejects.toThrow(/missing official plugin required asset.*browser-client\.mjs/iu);
    expect(backend.uploads).toEqual([]);
  });

  it("开发态 SSH 部署应上传本地 zcode.cjs 并生成远端 wrapper", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-remote-dev-agent-"));
    tempDirs.push(rootDir);
    const repoDir = join(rootDir, "z-code");
    const cliBundlePath = join(
      repoDir,
      "apps",
      "zcode-cli",
      "packages",
      "cli",
      "dist",
      "zcode.cjs",
    );
    await mkdir(dirname(cliBundlePath), { recursive: true });
    await writeFile(cliBundlePath, "console.log('dev zcode agent');\n", "utf8");
    await writeTestOfficialPluginPackages(repoDir);
    process.chdir(repoDir);
    process.env.ZCODE_REMOTE_DEV_AGENT_BUNDLE = "1";
    process.env[ZCODE_RUNTIME_ENV_KEY] = "development";

    const backend = new FakeRemoteBackend();
    const installedFiles: string[] = [];
    const installer: RemoteAssetInstaller = {
      mode: "remote-download",
      async resolveComponentVersion() {
        return "cdn-glm-version";
      },
      async installFile({ componentId, remotePath }) {
        installedFiles.push(`${componentId}:${remotePath}`);
      },
      async installDirectory() {
        throw new Error("installDirectory should not be called");
      },
    };

    await deployZCodeAgentRuntime(
      backend,
      { platform: "linux", arch: "arm64" },
      {
        platformArch: "linux-arm64",
        installer,
        selectedResourcePackageIds: ["glm"],
      },
      { log: () => undefined, logWarn: () => undefined },
    );

    expect(installedFiles).toEqual([]);
    const devBundleUpload = backend.uploads.find(
      (upload) =>
        upload.remotePath === "~/.zcode/server/agents/glm/zcode.cjs.new" ||
        upload.remotePath.startsWith(
          "~/.zcode/server/agents/glm/zcode.cjs.new-",
        ),
    );
    expect(
      devBundleUpload?.localPath.endsWith(DEV_CLI_BUNDLE_TEST_SUFFIX),
    ).toBe(true);
    expect(
      backend.commands.some(
        (command) =>
          command.includes("zcode-agent.new") && command.includes("zcode.cjs"),
      ),
    ).toBe(true);
    expect(
      backend.commands.some((command) => command.includes(".dev-version")),
    ).toBe(true);
    const officialPluginUpload = backend.uploads.find((upload) =>
      upload.remotePath.includes("/agents/glm/packages.tar.gz-"),
    );
    expect(officialPluginUpload?.remotePath).toMatch(
      /^~\/.zcode\/server\/agents\/glm\/packages\.tar\.gz-[\w-]+$/u,
    );
    expect(
      backend.commands.some(
        (command) =>
          command.includes("tar -xzf") &&
          command.includes("packages.tar.gz") &&
          command.includes("agents/glm/packages.extract-") &&
          command.includes("trap cleanup_staging EXIT"),
      ),
    ).toBe(true);
    const permissionRepairCommandIndex = backend.commands.findIndex((command) =>
      command.includes("command chmod -R u+rwX"),
    );
    const packageExtractCommandIndex = backend.commands.findIndex(
      (command) =>
        command.includes("tar -xzf") &&
        command.includes("packages.tar.gz") &&
        command.includes("agents/glm/packages"),
    );
    expect(permissionRepairCommandIndex).toBeGreaterThanOrEqual(0);
    expect(permissionRepairCommandIndex).toBeLessThan(
      packageExtractCommandIndex,
    );
  });

  it.each([true, false])("开发态标记相同时按实际 bundle 是否一致决定跳过上传：%s", async (bundleMatches) => {
    const rootDir = await mkdtemp(
      join(tmpdir(), "zcode-remote-dev-agent-skip-"),
    );
    tempDirs.push(rootDir);
    const repoDir = join(rootDir, "z-code");
    const cliBundlePath = join(
      repoDir,
      "apps",
      "zcode-cli",
      "packages",
      "cli",
      "dist",
      "zcode.cjs",
    );
    await mkdir(dirname(cliBundlePath), { recursive: true });
    await writeFile(
      cliBundlePath,
      "console.log('same dev zcode agent');\n",
      "utf8",
    );
    await writeTestOfficialPluginPackages(repoDir);
    process.chdir(repoDir);
    process.env.ZCODE_REMOTE_DEV_AGENT_BUNDLE = "1";
    process.env[ZCODE_RUNTIME_ENV_KEY] = "development";

    const devVersion = await computeDevelopmentAgentAssetsSha256ForTest(
      repoDir,
      cliBundlePath,
    );
    const backend = new FakeRemoteBackend({
      "~/.zcode/server/agents/glm/.version": `${ZCODE_AGENT_RUNTIME.version}\n`,
      "~/.zcode/server/agents/glm/.dev-version": `${devVersion}\n`,
      "~/.zcode/server/agents/glm/zcode-agent": "dev wrapper",
      "~/.zcode/server/agents/glm/zcode.cjs": bundleMatches
        ? "console.log('same dev zcode agent');\n"
        : "old published bundle without PAT support",
      ...Object.fromEntries(
        OFFICIAL_PLUGIN_REQUIRED_RELATIVE_PATHS.map((relativePath) => [
          `~/.zcode/server/agents/glm/packages/${relativePath}`,
          `dev official plugin ${relativePath}`,
        ]),
      ),
    }, { commandPlans: [{ matcher: /createHash/, exitCode: bundleMatches ? 0 : 1 }] });
    const installedFiles: string[] = [];
    const installer: RemoteAssetInstaller = {
      mode: "remote-download",
      async resolveComponentVersion() {
        return "cdn-glm-version";
      },
      async installFile({ componentId, remotePath }) {
        installedFiles.push(`${componentId}:${remotePath}`);
      },
      async installDirectory() {
        throw new Error("installDirectory should not be called");
      },
    };

    await deployZCodeAgentRuntime(
      backend,
      { platform: "linux", arch: "arm64" },
      {
        platformArch: "linux-arm64",
        installer,
        selectedResourcePackageIds: ["glm"],
      },
      { log: () => undefined, logWarn: () => undefined },
    );

    expect(installedFiles).toEqual([]);
    expect(backend.uploads.some((upload) => upload.remotePath.endsWith("zcode.cjs.new"))).toBe(!bundleMatches);
    expect(
      backend.commands.some((command) =>
        command.includes("command chmod -R u+rwX"),
      ),
    ).toBe(!bundleMatches);
  });

  it("darwin 远端强制部署时应上传 node-pty 的 spawn-helper", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-remote-deploy-"));
    tempDirs.push(rootDir);
    const mockCdnDir = join(rootDir, "mock-cdn");
    await stageRemoteRuntimeRelease(mockCdnDir, {
      platform: "darwin",
      arch: "arm64",
    });
    await mkdir(mockCdnDir, { recursive: true });
    const backend = new FakeRemoteBackend();

    await deployServer(
      backend,
      { platform: "darwin", arch: "arm64" },
      {
        force: true,
        mockCdnDir,
      },
    );

    expect(
      hasUploadForStagingTarget(
        backend,
        "~/.zcode/server/build/Release/spawn-helper.new",
      ),
    ).toBe(true);
  });

  it("远端覆盖替换应绕过 shell alias/function 并强制覆盖", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-remote-deploy-"));
    tempDirs.push(rootDir);
    const mockCdnDir = join(rootDir, "mock-cdn");
    await stageRemoteRuntimeRelease(mockCdnDir);
    await mkdir(mockCdnDir, { recursive: true });
    const backend = new FakeRemoteBackend();

    await deployServer(
      backend,
      { platform: "linux", arch: "arm64" },
      {
        force: true,
        mockCdnDir,
      },
    );

    const replaceCommands = backend.commands.filter(
      (command) => command.includes(".new") && command.includes("mv"),
    );

    expect(replaceCommands.length).toBeGreaterThan(0);
    for (const command of replaceCommands) {
      expect(command).toContain("command mv -f ");
      expect(command).not.toMatch(/(^|&& )mv /);
    }

    const chmodCommands = replaceCommands.filter((command) =>
      command.includes("chmod"),
    );
    expect(chmodCommands.length).toBeGreaterThan(0);
    for (const command of chmodCommands) {
      expect(command).toContain("command chmod +x ");
      expect(command).not.toMatch(/(^|&& )chmod \+x /);
    }
  });

  it("replace 命令在存在同名 shell function 时仍应执行真实 mv/chmod", async () => {
    if (process.platform === "win32") {
      return;
    }

    const rootDir = await mkdtemp(join(tmpdir(), "zcode-remote-replace-cmd-"));
    tempDirs.push(rootDir);
    const sourcePath = join(rootDir, "node.new");
    const targetPath = join(rootDir, "node");
    await writeFile(sourcePath, "new-runtime", "utf8");
    await writeFile(targetPath, "old-runtime", "utf8");

    const replaceCommand = buildRemoteExecutableReplaceCommand(
      sourcePath,
      targetPath,
    );

    execFileSync(
      "sh",
      [
        "-lc",
        [
          "set -eu",
          // Bugfix: 这里故意定义同名 shell function 模拟远端污染环境。
          // 如果 replace 命令没有使用 `command` 前缀，会命中函数并失败。
          "mv(){ echo SHOULD_NOT_CALL_MV_FUNCTION >&2; return 31; }",
          "chmod(){ echo SHOULD_NOT_CALL_CHMOD_FUNCTION >&2; return 32; }",
          replaceCommand,
        ].join("\n"),
      ],
      { stdio: "pipe" },
    );

    await expect(stat(sourcePath)).rejects.toThrow();
    expect(await readFile(targetPath, "utf8")).toBe("new-runtime");
    expect((await stat(targetPath)).mode & 0o111).not.toBe(0);
  });

  it("远端 replace 命令非 0 退出时应立即中断部署", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-remote-deploy-"));
    tempDirs.push(rootDir);
    const mockCdnDir = join(rootDir, "mock-cdn");
    await stageRemoteRuntimeRelease(mockCdnDir);
    await mkdir(mockCdnDir, { recursive: true });
    const backend = new FakeRemoteBackend(
      {},
      {
        commandPlans: [
          {
            matcher: /command mv -f .*zcode-server\.cjs/,
            exitCode: 23,
            stderrText: "mock mv failed",
          },
        ],
      },
    );

    await expect(
      deployServer(
        backend,
        { platform: "linux", arch: "arm64" },
        {
          force: true,
          mockCdnDir,
        },
      ),
    ).rejects.toThrow(/exit code 23/);
    expect(backend.lockReleaseMarkers[0]).toMatch(
      /^zcode-deploy-lock-release:/u,
    );
  });

  it("生产态未接入 CDN 下载占位时应抛出明确错误", async () => {
    const backend = new FakeRemoteBackend({
      "~/.zcode/server/agents/codex/.version": "0.0.0\n",
    });

    await expect(
      deployServer(
        backend,
        { platform: "linux", arch: "arm64" },
        {
          force: false,
          remoteCacheDir: "/tmp/zcode-remote-cache",
        },
      ),
    ).rejects.toThrow(
      /require remoteCdnBaseUrl or remoteCdnBaseUrls, remoteCacheDir and platformArch/,
    );
  });

  it("生产态 remoteCdnBaseUrl 固定到旧版本时应前置报错", async () => {
    const backend = new FakeRemoteBackend({
      "~/.zcode/server/agents/codex/.version": "0.0.0\n",
    });

    await expect(
      deployServer(
        backend,
        { platform: "linux", arch: "arm64" },
        {
          force: false,
          remoteCdnBaseUrl:
            "https://cdn.example.com/zcode/electron/releases-sandbox/fix-small-issues/0.2.7",
          remoteCacheDir: "/tmp/zcode-remote-cache",
        },
      ),
    ).rejects.toThrow(/remoteCdnBaseUrl 版本不匹配/);
  });

  it("生产态 manifest 存在时应优先下载组件产物并写入 cache（不走 legacy 整包）", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-remote-deploy-"));
    tempDirs.push(rootDir);

    const mockCdnDir = join(rootDir, "mock-cdn");
    const cdnRoot = join(rootDir, "cdn");
    const remoteCacheDir = join(rootDir, "remote-cache");
    await stageRemoteRuntimeRelease(mockCdnDir);
    const manifest = await stageRemoteComponentArtifacts(mockCdnDir, cdnRoot);
    await stageRemoteAssetArchive(mockCdnDir, cdnRoot);
    const cdnServer = await createStaticFileServer(cdnRoot);
    const glmBundle = manifest.components.find(
      (component) => component.id === "glm",
    );
    if (!glmBundle) {
      throw new Error("missing glm component in staged manifest");
    }
    try {
      const remoteFiles = {
        "~/.zcode/server/agents/codex/.version": "0.0.0\n",
      };
      addMatchingServerBundleArtifactIdentity(
        remoteFiles,
        manifest,
        "linux-arm64",
      );
      const backend = new FakeRemoteBackend(remoteFiles);
      const deployed = await deployServer(
        backend,
        { platform: "linux", arch: "arm64" },
        {
          force: false,
          remoteCdnBaseUrl: cdnServer.baseUrl,
          remoteCacheDir,
          resourcePackages: {
            selectedPackageIds: [`${retiredProtocolPrefix}-codex`, "ripgrep"],
          },
        },
      );

      expect(deployed).toBe(false);
      expect(
        hasUploadForStagingTarget(
          backend,
          "~/.zcode/server/agents/glm/zcode.cjs.new",
        ),
      ).toBe(true);
      expect(
        backend.uploads.some(
          (upload) =>
            upload.remotePath === "~/.zcode/server/agents/codex.tar.gz",
        ),
      ).toBe(false);
      expect(
        hasUploadForStagingTarget(
          backend,
          "~/.zcode/server/tools/ripgrep/rg.new",
        ),
      ).toBe(true);
      expect(
        cdnServer.getRequestCount(
          `/${ZCODE_VERSION}/manifest-linux-arm64.json`,
        ),
      ).toBe(1);
      expect(
        cdnServer.getRequestCount(
          `/${ZCODE_VERSION}/remote-assets-linux-arm64.tar.gz`,
        ),
      ).toBe(0);
      expect(
        cdnServer.getRequestCount(
          toComponentArtifactRequestPath(glmBundle.artifactPath),
        ),
      ).toBe(1);
    } finally {
      await cdnServer.close();
    }
  });

  it("本地下载后上传通过注入的远程资源网络出口获取 manifest 和组件", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-remote-deploy-"));
    tempDirs.push(rootDir);

    const mockCdnDir = join(rootDir, "mock-cdn");
    const cdnRoot = join(rootDir, "cdn");
    const remoteCacheDir = join(rootDir, "remote-cache");
    await stageRemoteRuntimeRelease(mockCdnDir);
    const manifest = await stageRemoteComponentArtifacts(mockCdnDir, cdnRoot);
    const cdnServer = await createStaticFileServer(cdnRoot);
    const originalFetch = globalThis.fetch.bind(globalThis);
    const remoteAssetFetch = vi.fn<typeof fetch>((input, init) =>
      originalFetch(input, init),
    );
    const directFetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("remote asset direct fetch is forbidden"));

    try {
      const remoteFiles = createFullyDeployedRemoteFiles("linux-arm64");
      addMatchingServerBundleArtifactIdentity(
        remoteFiles,
        manifest,
        "linux-arm64",
      );
      const backend = new FakeRemoteBackend(remoteFiles);

      await deployServer(
        backend,
        { platform: "linux", arch: "arm64" },
        {
          remoteAssetNetwork: { fetch: remoteAssetFetch },
          remoteCdnBaseUrl: cdnServer.baseUrl,
          remoteCacheDir,
        },
      );

      expect(directFetch).not.toHaveBeenCalled();
      expect(
        remoteAssetFetch.mock.calls.some(([input]) =>
          String(input).endsWith(
            `/${ZCODE_VERSION}/manifest-linux-arm64.json`,
          ),
        ),
      ).toBe(true);
      const glmComponent = findManifestComponent(manifest, "glm");
      expect(
        remoteAssetFetch.mock.calls.some(([input]) =>
          String(input).endsWith(`/${glmComponent.artifactPath}`),
        ),
      ).toBe(true);
      expect(
        hasUploadForStagingTarget(
          backend,
          "~/.zcode/server/agents/glm/zcode.cjs.new",
        ),
      ).toBe(true);
    } finally {
      directFetch.mockRestore();
      await cdnServer.close();
    }
  });

  it("远程资源网络出口失败时不回退 global fetch", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-remote-deploy-"));
    tempDirs.push(rootDir);
    const directFetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("unexpected direct response", { status: 200 }));
    const remoteAssetFetch = vi.fn<typeof fetch>(async () => {
      throw new Error("configured proxy unavailable");
    });

    try {
      await expect(
        ensureRemoteReleaseDirFromCdn(
          {
            remoteAssetNetwork: { fetch: remoteAssetFetch },
            remoteCdnBaseUrl: "https://remote-assets.example.test",
            remoteCacheDir: join(rootDir, "remote-cache"),
            version: ZCODE_VERSION,
            platformArch: "linux-arm64",
            componentIds: ["glm"],
          },
          { log: () => undefined, logWarn: () => undefined },
        ),
      ).rejects.toThrow("configured proxy unavailable");
      expect(remoteAssetFetch).toHaveBeenCalled();
      expect(directFetch).not.toHaveBeenCalled();
    } finally {
      directFetch.mockRestore();
    }
  });

  it("mock-cdn 版本目录存在但缺目标平台组件时应回退 CDN cache", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-remote-deploy-"));
    tempDirs.push(rootDir);

    const mockCdnDir = join(rootDir, "mock-cdn");
    const cdnSourceMockCdnDir = join(rootDir, "cdn-source-mock-cdn");
    const cdnRoot = join(rootDir, "cdn");
    const remoteCacheDir = join(rootDir, "remote-cache");
    await stageRemoteRuntimeRelease(mockCdnDir, {
      platform: "linux",
      arch: "arm64",
    });
    await stageRemoteRuntimeRelease(cdnSourceMockCdnDir, {
      platform: "linux",
      arch: "x64",
    });
    await stageRemoteComponentArtifacts(cdnSourceMockCdnDir, cdnRoot, {
      platformKey: "linux-x64",
    });
    const cdnServer = await createStaticFileServer(cdnRoot);

    try {
      const backend = new FakeRemoteBackend();
      const deployed = await deployServer(
        backend,
        { platform: "linux", arch: "x64" },
        {
          force: true,
          mockCdnDir,
          remoteCdnBaseUrl: cdnServer.baseUrl,
          remoteCacheDir,
        },
      );

      const nodeUpload = backend.uploads.find((upload) =>
        upload.remotePath.startsWith("~/.zcode/server/node.new-"),
      );
      expect(deployed).toBe(true);
      expect(nodeUpload?.localPath).toContain(remoteCacheDir);
      expect(nodeUpload?.localPath).not.toContain(mockCdnDir);
      expect(
        cdnServer.getRequestCount(`/${ZCODE_VERSION}/manifest-linux-x64.json`),
      ).toBeGreaterThan(0);
    } finally {
      await cdnServer.close();
    }
  });

  it("mock manifest 存在但 GLM 文件缺失时应使用 CDN SHA 决策与部署", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-remote-deploy-"));
    tempDirs.push(rootDir);
    const mockCdnDir = join(rootDir, "mock-cdn");
    const cdnSourceDir = join(rootDir, "cdn-source");
    const cdnRoot = join(rootDir, "cdn");
    const remoteCacheDir = join(rootDir, "remote-cache");
    await stageRemoteRuntimeRelease(mockCdnDir);
    const mockManifest = await stageRemoteComponentArtifacts(
      mockCdnDir,
      join(mockCdnDir, "releases"),
    );
    await stageRemoteRuntimeRelease(cdnSourceDir);
    await writeFile(
      join(
        cdnSourceDir,
        "releases",
        ZCODE_VERSION,
        "glm",
        "linux-arm64",
        "zcode.cjs",
      ),
      "new CDN GLM bytes under the same semantic version",
      "utf8",
    );
    const cdnManifest = await stageRemoteComponentArtifacts(
      cdnSourceDir,
      cdnRoot,
    );
    const mockGlm = mockManifest.components.find(
      (component) => component.id === "glm",
    );
    const cdnGlm = cdnManifest.components.find(
      (component) => component.id === "glm",
    );
    expect(cdnGlm?.version).toBe(mockGlm?.version);
    expect(cdnGlm?.sha256).not.toBe(mockGlm?.sha256);
    await rm(
      join(
        mockCdnDir,
        "releases",
        ZCODE_VERSION,
        "glm",
        "linux-arm64",
        "zcode.cjs",
      ),
    );
    const remoteFiles = createFullyDeployedRemoteFiles("linux-arm64");
    addMatchingGlmArtifactIdentity(remoteFiles, mockManifest, "linux-arm64");
    const backend = new FakeRemoteBackend(remoteFiles);
    const cdnServer = await createStaticFileServer(cdnRoot);

    try {
      await deployServer(
        backend,
        { platform: "linux", arch: "arm64" },
        {
          mockCdnDir,
          remoteCdnBaseUrl: cdnServer.baseUrl,
          remoteCacheDir,
        },
      );

      expect(
        hasUploadForStagingTarget(
          backend,
          "~/.zcode/server/agents/glm/zcode.cjs.new",
        ),
      ).toBe(true);
      expect(backend.commands.join("\n")).toContain(cdnGlm?.sha256);
    } finally {
      await cdnServer.close();
    }
  });

  it("本地上传的 GLM hash 变化时不应复用完整的旧语义版本 cache", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-remote-deploy-"));
    tempDirs.push(rootDir);

    const mockCdnDir = join(rootDir, "mock-cdn");
    const cdnRoot = join(rootDir, "cdn");
    const remoteCacheDir = join(rootDir, "remote-cache");
    await stageRemoteRuntimeRelease(mockCdnDir);
    const manifest = await stageRemoteComponentArtifacts(mockCdnDir, cdnRoot, {
      mutateManifest: (sourceManifest) => ({
        ...sourceManifest,
        components: sourceManifest.components.map((component) =>
          component.id === "glm"
            ? { ...component, version: `${component.version}+aaaaaaaaaaaa` }
            : component,
        ),
      }),
    });
    const glmComponent = manifest.components.find(
      (component) => component.id === "glm",
    );
    if (!glmComponent) {
      throw new Error("missing glm component in staged manifest");
    }
    const glmSemanticVersion = glmComponent.version.replace(
      /\+[a-f0-9]{12,64}$/u,
      "",
    );
    const staleComponentDir = join(
      remoteCacheDir,
      "components",
      "glm",
      "linux-arm64",
      glmSemanticVersion,
    );
    await mkdir(staleComponentDir, { recursive: true });
    await writeFile(join(staleComponentDir, ".ready"), "ready\n", "utf8");
    await writeFile(join(staleComponentDir, "zcode.cjs"), "stale glm bundle");
    for (const relativePath of OFFICIAL_PLUGIN_REQUIRED_RELATIVE_PATHS) {
      const stalePluginPath = join(
        staleComponentDir,
        "packages",
        ...relativePath.split("/"),
      );
      await mkdir(dirname(stalePluginPath), { recursive: true });
      await writeFile(stalePluginPath, "stale official plugin", "utf8");
    }

    const remoteFiles = createFullyDeployedRemoteFiles("linux-arm64");
    addMatchingServerBundleArtifactIdentity(
      remoteFiles,
      manifest,
      "linux-arm64",
    );
    delete remoteFiles[
      "~/.zcode/server/agents/glm/packages/skill-creator-plugin/.zcode-plugin/plugin.json"
    ];
    const cdnServer = await createStaticFileServer(cdnRoot);

    try {
      const backend = new FakeRemoteBackend(remoteFiles);

      const deployed = await deployServer(
        backend,
        { platform: "linux", arch: "arm64" },
        {
          force: false,
          remoteCdnBaseUrl: cdnServer.baseUrl,
          remoteCacheDir,
        },
      );

      expect(deployed).toBe(false);
      expect(
        backend.uploads.some((upload) =>
          upload.remotePath.startsWith(
            "~/.zcode/server/agents/glm/packages.tar.gz-",
          ),
        ),
      ).toBe(true);
      expect(
        cdnServer.getRequestCount(
          toComponentArtifactRequestPath(glmComponent.artifactPath),
        ),
      ).toBe(1);
      await expect(
        readFile(
          join(
            remoteCacheDir,
            "components",
            "glm",
            "linux-arm64",
            glmComponent.sha256,
            "packages",
            "skill-creator-plugin",
            ".zcode-plugin",
            "plugin.json",
          ),
          "utf8",
        ),
      ).resolves.toContain("glm official plugin");
      await expect(
        readFile(join(staleComponentDir, "zcode.cjs"), "utf8"),
      ).resolves.toBe("stale glm bundle");
    } finally {
      await cdnServer.close();
    }
  });

  it("并发预热复用 release 锁后仍应按当前 required paths 补齐残缺 component cache", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-remote-deploy-"));
    tempDirs.push(rootDir);

    const mockCdnDir = join(rootDir, "mock-cdn");
    const cdnRoot = join(rootDir, "cdn");
    const remoteCacheDir = join(rootDir, "remote-cache");
    await stageRemoteRuntimeRelease(mockCdnDir);
    const manifest = await stageRemoteComponentArtifacts(mockCdnDir, cdnRoot, {
      mutateManifest: (sourceManifest) => ({
        ...sourceManifest,
        components: sourceManifest.components.map((component) =>
          component.id === "glm"
            ? { ...component, version: `${component.version}+bbbbbbbbbbbb` }
            : component,
        ),
      }),
    });
    const glmComponent = manifest.components.find(
      (component) => component.id === "glm",
    );
    if (!glmComponent) {
      throw new Error("missing glm component in staged manifest");
    }
    const glmSemanticVersion = glmComponent.version.replace(
      /\+[a-f0-9]{12,64}$/u,
      "",
    );
    const staleComponentDir = join(
      remoteCacheDir,
      "components",
      "glm",
      "linux-arm64",
      glmSemanticVersion,
    );
    await mkdir(staleComponentDir, { recursive: true });
    await writeFile(join(staleComponentDir, ".ready"), "ready\n", "utf8");
    await writeFile(join(staleComponentDir, "zcode.cjs"), "stale glm bundle");
    const requiredReleasePath =
      "glm/linux-arm64/packages/skill-creator-plugin/.zcode-plugin/plugin.json";
    const cdnServer = await createStaticFileServer(cdnRoot);

    try {
      const [releaseDirWithoutRequired, releaseDirWithRequired] =
        await Promise.all([
          ensureRemoteReleaseDirFromCdn(
            {
              remoteCdnBaseUrl: cdnServer.baseUrl,
              remoteCacheDir,
              version: ZCODE_VERSION,
              platformArch: "linux-arm64",
              componentIds: ["glm"],
            },
            { log: () => {}, logWarn: () => {} },
          ),
          ensureRemoteReleaseDirFromCdn(
            {
              remoteCdnBaseUrl: cdnServer.baseUrl,
              remoteCacheDir,
              version: ZCODE_VERSION,
              platformArch: "linux-arm64",
              componentIds: ["glm"],
              requiredReleasePaths: [requiredReleasePath],
            },
            { log: () => {}, logWarn: () => {} },
          ),
        ]);

      expect(releaseDirWithRequired).toBe(releaseDirWithoutRequired);
      await expect(
        readFile(join(releaseDirWithRequired, requiredReleasePath), "utf8"),
      ).resolves.toContain("glm official plugin");
      expect(
        cdnServer.getRequestCount(
          toComponentArtifactRequestPath(glmComponent.artifactPath),
        ),
      ).toBe(1);
    } finally {
      await cdnServer.close();
    }
  });

  it("node-runtime manifest version 带内容 hash 时，远端已安装语义版本应继续跳过", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-remote-deploy-"));
    tempDirs.push(rootDir);

    const mockCdnDir = join(rootDir, "mock-cdn");
    const cdnRoot = join(rootDir, "cdn");
    const remoteCacheDir = join(rootDir, "remote-cache");
    await stageRemoteRuntimeRelease(mockCdnDir);
    const manifest = await stageRemoteComponentArtifacts(mockCdnDir, cdnRoot, {
      mutateManifest: (manifest) => ({
        ...manifest,
        components: manifest.components.map((component) =>
          component.id === "node-runtime"
            ? { ...component, version: `${component.version}+aaaaaaaaaaaa` }
            : component,
        ),
      }),
    });
    const cdnServer = await createStaticFileServer(cdnRoot);

    try {
      const remoteFiles = {
        "~/.zcode/server/version.txt": `${ZCODE_VERSION}\n`,
        "~/.zcode/server/node": "node",
        "~/.zcode/server/.asset-components/node-runtime.json":
          '{"id":"node-runtime","version":"24.10.0-node-runtime","platformArch":"linux-arm64"}\n',
        "~/.zcode/server/build/Release/pty.node": "pty",
        "~/.zcode/server/.asset-components/node-pty.json":
          '{"id":"node-pty","version":"1.0.0-node-pty","platformArch":"linux-arm64"}\n',
      };
      addMatchingServerBundleArtifactIdentity(
        remoteFiles,
        manifest,
        "linux-arm64",
      );
      const backend = new FakeRemoteBackend(remoteFiles);
      const deployed = await deployServer(
        backend,
        { platform: "linux", arch: "arm64" },
        {
          force: false,
          remoteCdnBaseUrl: cdnServer.baseUrl,
          remoteCacheDir,
          resourcePackages: {
            selectedPackageIds: ["server-bundle", "node-runtime", "node-pty"],
          },
        },
      );

      expect(deployed).toBe(false);
      expect(backend.commands.join("\n")).not.toContain("node.new");
      expect(backend.commands.join("\n")).not.toContain("node-runtime");
    } finally {
      await cdnServer.close();
    }
  });

  it("旧 provider 资源选择不应再回落 CDN 下载三方 provider", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-remote-deploy-"));
    tempDirs.push(rootDir);

    const mockCdnDir = join(rootDir, "mock-cdn");
    const cdnRoot = join(rootDir, "cdn");
    const remoteCacheDir = join(rootDir, "remote-cache");
    await stageRemoteRuntimeRelease(mockCdnDir);
    await stageRemoteComponentArtifacts(mockCdnDir, cdnRoot);
    await rm(
      join(
        mockCdnDir,
        "releases",
        ZCODE_VERSION,
        retiredProtocolPrefix,
        "linux-arm64",
        retiredProtocolPrefix,
      ),
      { recursive: true, force: true },
    );
    const cdnServer = await createStaticFileServer(cdnRoot);

    try {
      const backend = new FakeRemoteBackend({
        ...createFullyDeployedRemoteFiles("linux-arm64"),
        [`~/.zcode/server/agents/${retiredProtocolPrefix}/.version`]: "0.0.0\n",
      });

      const deployed = await deployServer(
        backend,
        { platform: "linux", arch: "arm64" },
        {
          force: false,
          mockCdnDir,
          remoteCdnBaseUrl: cdnServer.baseUrl,
          remoteCacheDir,
          resourcePackages: {
            selectedPackageIds: [`${retiredProtocolPrefix}-claude`],
          },
        },
      );

      expect(deployed).toBe(false);
      expect(
        backend.uploads.some(
          (upload) =>
            upload.remotePath ===
            `~/.zcode/server/agents/${retiredProtocolPrefix}.tar.gz`,
        ),
      ).toBe(false);
      expect(
        cdnServer.getRequestCount(
          `/${ZCODE_VERSION}/manifest-linux-arm64.json`,
        ),
      ).toBe(0);
    } finally {
      await cdnServer.close();
    }
  });

  it("ssh remote-download mode installs server assets without local uploads", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-remote-deploy-"));
    tempDirs.push(rootDir);

    const mockCdnDir = join(rootDir, "mock-cdn");
    const cdnRoot = join(rootDir, "cdn");
    await stageRemoteRuntimeRelease(mockCdnDir);
    await stageRemoteComponentArtifacts(mockCdnDir, cdnRoot);
    const cdnServer = await createStaticFileServer(cdnRoot);

    try {
      const backend = new FakeRemoteBackend(
        Object.fromEntries(
          Object.entries(LEGACY_REMOTE_TEST_AGENT_RUNTIME)
            .filter(([, runtime]) => runtime.binaryKind === "node-script")
            .map(([provider, runtime]) => [
              `~/.zcode/server/agents/${runtime.bundledResourceDir}/.bundle-meta.json`,
              JSON.stringify({
                provider,
                version: runtime.version,
                platform: "linux-arm64",
              }),
            ]),
        ),
        {
          serverVersion: "0.0.0-old",
          commandPlans: [
            {
              matcher: /command -v curl/,
              exitCode: 0,
              stdoutText: "download=curl\ntar=tar\nsha256=sha256sum\n",
            },
          ],
        },
      );

      const deployed = await deployServer(
        backend,
        { platform: "linux", arch: "arm64" },
        {
          force: true,
          assetInstallMode: "remote-download",
          remoteCdnBaseUrl: cdnServer.baseUrl,
        },
      );

      expect(deployed).toBe(true);
      expect(backend.uploads).toEqual([]);
      expect(
        backend.commands.some((command) => command.includes("curl -fL")),
      ).toBe(true);
      expect(
        backend.commands.some((command) => command.includes("sha256sum")),
      ).toBe(true);
      expect(
        cdnServer.getRequestCount(
          `/${ZCODE_VERSION}/manifest-linux-arm64.json`,
        ),
      ).toBe(1);
    } finally {
      await cdnServer.close();
    }
  });

  it("remote-download 命中 claude 0.29.2 组件缓存时不要求 native binary", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-remote-deploy-"));
    tempDirs.push(rootDir);

    const mockCdnDir = join(rootDir, "mock-cdn");
    const cdnRoot = join(rootDir, "cdn");
    await stageRemoteRuntimeRelease(mockCdnDir, {
      platform: "linux",
      arch: "x64",
    });
    const manifest = await stageRemoteComponentArtifacts(mockCdnDir, cdnRoot, {
      platformKey: "linux-x64",
      mutateManifest: (input) => ({
        ...input,
        components: input.components.map((component) =>
          component.id === `${retiredProtocolPrefix}-claude`
            ? { ...component, version: `${component.version}+abcdef123456` }
            : component,
        ),
      }),
    });
    const cdnServer = await createStaticFileServer(cdnRoot);
    const claudeBundle = manifest.components.find(
      (component) => component.id === `${retiredProtocolPrefix}-claude`,
    );
    if (!claudeBundle) {
      throw new Error("missing retired claude component in staged manifest");
    }

    const cachedComponentDir = resolveRemoteComponentCacheDirForTest(
      "linux-x64",
      claudeBundle.id,
      claudeBundle.version,
    );
    const deployedFiles = createFullyDeployedRemoteFiles("linux-x64");
    addMatchingServerBundleArtifactIdentity(
      deployedFiles,
      manifest,
      "linux-x64",
    );
    delete deployedFiles[
      `~/.zcode/server/agents/${retiredProtocolPrefix}/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude`
    ];
    const backend = new FakeRemoteBackend(
      {
        ...deployedFiles,
        [`~/.zcode/server/.asset-components/${retiredProtocolPrefix}-claude.json`]:
          JSON.stringify({
            id: `${retiredProtocolPrefix}-claude`,
            version: claudeBundle.version,
            platformArch: "linux-x64",
          }),
        [`${cachedComponentDir}/.ready`]: "ready",
        [`${cachedComponentDir}/dist/index.js`]: "cached claude entry",
        [`${cachedComponentDir}/.bundle-meta.json`]: JSON.stringify({
          provider: "claude",
          version: LEGACY_REMOTE_TEST_AGENT_RUNTIME.claude.version,
          platform: "linux-x64",
        }),
      },
      {
        commandPlans: [
          {
            matcher: /command -v curl/u,
            exitCode: 0,
            stdoutText: "download=curl\ntar=tar\nsha256=sha256sum\n",
          },
          {
            matcher: new RegExp(
              `rm -rf "\\$HOME"'\\/\\.zcode\\/server\\/asset-cache\\/components\\/linux-x64\\/${retiredProtocolPrefix}-claude`,
              "u",
            ),
            exitCode: 0,
            onExec: () => {
              for (const remotePath of Array.from(backend.remoteFiles.keys())) {
                if (remotePath.startsWith(cachedComponentDir)) {
                  backend.remoteFiles.delete(remotePath);
                }
              }
            },
          },
        ],
      },
    );

    try {
      const deployed = await deployServer(
        backend,
        { platform: "linux", arch: "x64" },
        {
          force: false,
          assetInstallMode: "remote-download",
          remoteCdnBaseUrl: cdnServer.baseUrl,
          resourcePackages: {
            selectedPackageIds: [`${retiredProtocolPrefix}-claude`],
          },
        },
      );

      expect(deployed).toBe(false);
      expect(
        backend.commands.some((command) =>
          command.includes(
            `rm -rf "$HOME"'/.zcode/server/asset-cache/components/linux-x64/${retiredProtocolPrefix}-claude/${cachedComponentDir.split("/").at(-1) ?? ""}'`,
          ),
        ),
      ).toBe(false);
      expect(
        backend.commands.some((command) =>
          command.includes(
            `test -e "$HOME"'/.zcode/server/agents/${retiredProtocolPrefix}/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude'`,
          ),
        ),
      ).toBe(false);
      expect(
        cdnServer.getRequestCount(
          toVersionedArtifactRequestPath(claudeBundle.artifactPath),
        ),
      ).toBe(0);
    } finally {
      await cdnServer.close();
    }
  });

  it("remote-download 下旧 claude 选择应下载 glm 组件而不是 claude", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-remote-deploy-"));
    tempDirs.push(rootDir);

    const mockCdnDir = join(rootDir, "mock-cdn");
    const cdnRoot = join(rootDir, "cdn");
    await stageRemoteRuntimeRelease(mockCdnDir, {
      platform: "linux",
      arch: "x64",
    });
    const localClaudeDir = join(
      mockCdnDir,
      "releases",
      ZCODE_VERSION,
      retiredProtocolPrefix,
      "linux-x64",
      LEGACY_REMOTE_TEST_AGENT_RUNTIME.claude.bundledResourceDir,
    );
    await writeFile(
      join(localClaudeDir, ".bundle-meta.json"),
      JSON.stringify({
        provider: "claude",
        version: LEGACY_REMOTE_TEST_AGENT_RUNTIME.claude.version,
        platform: "linux-x64",
        patchFingerprint: "patch-new",
      }),
      "utf8",
    );
    const manifest = await stageRemoteComponentArtifacts(mockCdnDir, cdnRoot, {
      platformKey: "linux-x64",
    });
    const cdnServer = await createStaticFileServer(cdnRoot);
    const claudeBundle = manifest.components.find(
      (component) => component.id === `${retiredProtocolPrefix}-claude`,
    );
    if (!claudeBundle) {
      throw new Error("missing retired claude component in staged manifest");
    }

    const remoteFiles = createFullyDeployedRemoteFiles("linux-x64");
    addMatchingGlmAndServerArtifactIdentities(
      remoteFiles,
      manifest,
      "linux-x64",
    );
    const backend = new FakeRemoteBackend(
      {
        ...remoteFiles,
        [`~/.zcode/server/.asset-components/${retiredProtocolPrefix}-claude.json`]:
          JSON.stringify({
            id: `${retiredProtocolPrefix}-claude`,
            version: "0.29.2+oldhash000000",
            platformArch: "linux-x64",
          }),
      },
      {
        commandPlans: [
          {
            matcher: /command -v curl/u,
            exitCode: 0,
            stdoutText: "download=curl\ntar=tar\nsha256=sha256sum\n",
          },
        ],
      },
    );

    try {
      const deployed = await deployServer(
        backend,
        { platform: "linux", arch: "x64" },
        {
          force: false,
          assetInstallMode: "remote-download",
          remoteCdnBaseUrl: cdnServer.baseUrl,
          resourcePackages: {
            selectedPackageIds: [`${retiredProtocolPrefix}-claude`],
          },
        },
      );

      expect(deployed).toBe(false);
      expect(
        backend.commands.some((command) =>
          command.includes(claudeBundle.artifactPath),
        ),
      ).toBe(false);
      expect(
        backend.commands.some((command) =>
          command.includes("/components/linux-x64/glm/"),
        ),
      ).toBe(false);
      expect(
        cdnServer.getRequestCount(`/${ZCODE_VERSION}/manifest-linux-x64.json`),
      ).toBe(1);
    } finally {
      await cdnServer.close();
    }
  });

  it("生产态 manifest 初次 404 后同进程重试应重新探测 manifest", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-remote-deploy-"));
    tempDirs.push(rootDir);

    const mockCdnDir = join(rootDir, "mock-cdn");
    const cdnRoot = join(rootDir, "cdn");
    const remoteCacheDir = join(rootDir, "remote-cache");
    await stageRemoteRuntimeRelease(mockCdnDir);
    const cdnServer = await createStaticFileServer(cdnRoot);

    try {
      await expect(
        ensureRemoteReleaseDirFromCdn(
          {
            remoteCdnBaseUrl: cdnServer.baseUrl,
            remoteCacheDir,
            version: ZCODE_VERSION,
            platformArch: "linux-arm64",
          },
          { log: () => {}, logWarn: () => {} },
        ),
      ).rejects.toThrow(/manifest not found/u);

      const manifest = await stageRemoteComponentArtifacts(mockCdnDir, cdnRoot);
      const serverBundle = manifest.components.find(
        (component) => component.id === "server-bundle",
      );
      if (!serverBundle) {
        throw new Error("missing server-bundle component in staged manifest");
      }
      const glm = manifest.components.find(
        (component) => component.id === "glm",
      );
      if (!glm) {
        throw new Error("missing glm component in staged manifest");
      }

      await expect(
        ensureRemoteReleaseDirFromCdn(
          {
            remoteCdnBaseUrl: cdnServer.baseUrl,
            remoteCacheDir,
            version: ZCODE_VERSION,
            platformArch: "linux-arm64",
          },
          { log: () => {}, logWarn: () => {} },
        ),
      ).resolves.toBe(
        join(
          remoteCacheDir,
          "releases",
          ZCODE_VERSION,
          "linux-arm64",
          "glm-content",
          glm.sha256,
        ),
      );
      expect(
        cdnServer.getRequestCount(
          `/${ZCODE_VERSION}/manifest-linux-arm64.json`,
        ),
      ).toBe(2);
      expect(
        cdnServer.getRequestCount(
          toVersionedArtifactRequestPath(serverBundle.artifactPath),
        ),
      ).toBe(0);
      expect(
        cdnServer.getRequestCount(
          toComponentArtifactRequestPath(serverBundle.artifactPath),
        ),
      ).toBe(1);
    } finally {
      await cdnServer.close();
    }
  });

  it("生产态 remoteCdnBaseUrl 已固定版本时组件应从跨版本 components 根下载", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-remote-deploy-"));
    tempDirs.push(rootDir);

    const mockCdnDir = join(rootDir, "mock-cdn");
    const cdnRoot = join(rootDir, "cdn");
    const remoteCacheDir = join(rootDir, "remote-cache");
    await stageRemoteRuntimeRelease(mockCdnDir);
    const manifest = await stageRemoteComponentArtifacts(mockCdnDir, cdnRoot);
    const cdnServer = await createStaticFileServer(cdnRoot);
    const serverBundle = manifest.components.find(
      (component) => component.id === "server-bundle",
    );
    if (!serverBundle) {
      throw new Error("missing server-bundle component in staged manifest");
    }
    const glm = manifest.components.find((component) => component.id === "glm");
    if (!glm) {
      throw new Error("missing glm component in staged manifest");
    }

    try {
      await expect(
        ensureRemoteReleaseDirFromCdn(
          {
            remoteCdnBaseUrl: `${cdnServer.baseUrl}/${ZCODE_VERSION}`,
            remoteCacheDir,
            version: ZCODE_VERSION,
            platformArch: "linux-arm64",
          },
          { log: () => {}, logWarn: () => {} },
        ),
      ).resolves.toBe(
        join(
          remoteCacheDir,
          "releases",
          ZCODE_VERSION,
          "linux-arm64",
          "glm-content",
          glm.sha256,
        ),
      );
      expect(
        cdnServer.getRequestCount(
          `/${ZCODE_VERSION}/manifest-linux-arm64.json`,
        ),
      ).toBe(1);
      expect(
        cdnServer.getRequestCount(
          toVersionedArtifactRequestPath(serverBundle.artifactPath),
        ),
      ).toBe(0);
      expect(
        cdnServer.getRequestCount(
          toComponentArtifactRequestPath(serverBundle.artifactPath),
        ),
      ).toBe(1);
    } finally {
      await cdnServer.close();
    }
  });

  it("生产态主 CDN 缺失组件时应回退到备选 CDN 下载组件", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-remote-deploy-"));
    tempDirs.push(rootDir);

    const mockCdnDir = join(rootDir, "mock-cdn");
    const primaryCdnRoot = join(rootDir, "primary-cdn");
    const backupCdnRoot = join(rootDir, "backup-cdn");
    const remoteCacheDir = join(rootDir, "remote-cache");
    await stageRemoteRuntimeRelease(mockCdnDir);
    const backupManifest = await stageRemoteComponentArtifacts(
      mockCdnDir,
      backupCdnRoot,
    );
    await mkdir(join(primaryCdnRoot, ZCODE_VERSION), { recursive: true });
    await writeFile(
      join(primaryCdnRoot, ZCODE_VERSION, "manifest-linux-arm64.json"),
      JSON.stringify(backupManifest, null, 2),
      "utf8",
    );
    const primaryCdnServer = await createStaticFileServer(primaryCdnRoot);
    const backupCdnServer = await createStaticFileServer(backupCdnRoot);
    const ripgrepBundle = backupManifest.components.find(
      (component) => component.id === "ripgrep",
    );
    if (!ripgrepBundle) {
      throw new Error("missing ripgrep component in staged manifest");
    }

    try {
      const remoteFiles = {
        "~/.zcode/server/agents/codex/.version": "0.0.0\n",
      };
      addMatchingServerBundleArtifactIdentity(
        remoteFiles,
        backupManifest,
        "linux-arm64",
      );
      const backend = new FakeRemoteBackend(remoteFiles);
      const deployed = await deployServer(
        backend,
        { platform: "linux", arch: "arm64" },
        {
          force: false,
          remoteCdnBaseUrls: [
            primaryCdnServer.baseUrl,
            backupCdnServer.baseUrl,
          ],
          remoteCacheDir,
          resourcePackages: {
            selectedPackageIds: [retiredProxyRuntimeId],
          },
        },
      );

      expect(deployed).toBe(false);
      expect(
        primaryCdnServer.getRequestCount(
          `/${ZCODE_VERSION}/manifest-linux-arm64.json`,
        ),
      ).toBe(1);
      expect(
        backupCdnServer.getRequestCount(
          `/${ZCODE_VERSION}/manifest-linux-arm64.json`,
        ),
      ).toBe(0);
      expect(
        primaryCdnServer.getRequestCount(
          toVersionedArtifactRequestPath(ripgrepBundle.artifactPath),
        ),
      ).toBe(1);
      expect(
        primaryCdnServer.getRequestCount(
          toComponentArtifactRequestPath(ripgrepBundle.artifactPath),
        ),
      ).toBe(1);
      expect(
        backupCdnServer.getRequestCount(
          toVersionedArtifactRequestPath(ripgrepBundle.artifactPath),
        ),
      ).toBe(0);
      expect(
        backupCdnServer.getRequestCount(
          toComponentArtifactRequestPath(ripgrepBundle.artifactPath),
        ),
      ).toBe(1);
      expect(
        primaryCdnServer.getRequestCount(
          `/${ZCODE_VERSION}/remote-assets-linux-arm64.tar.gz`,
        ),
      ).toBe(0);
      expect(
        backupCdnServer.getRequestCount(
          `/${ZCODE_VERSION}/remote-assets-linux-arm64.tar.gz`,
        ),
      ).toBe(0);
    } finally {
      await primaryCdnServer.close();
      await backupCdnServer.close();
    }
  });

  it("manifest 命中备 CDN 时应优先从同一 CDN 下载 GLM 制品", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-remote-deploy-"));
    tempDirs.push(rootDir);

    const mockCdnDir = join(rootDir, "mock-cdn");
    const primaryCdnRoot = join(rootDir, "primary-cdn");
    const backupCdnRoot = join(rootDir, "backup-cdn");
    const remoteCacheDir = join(rootDir, "remote-cache");
    await stageRemoteRuntimeRelease(mockCdnDir);
    const backupManifest = await stageRemoteComponentArtifacts(
      mockCdnDir,
      backupCdnRoot,
    );
    const glm = backupManifest.components.find(
      (component) => component.id === "glm",
    );
    if (!glm) {
      throw new Error("missing glm component in staged manifest");
    }
    await mkdir(dirname(join(primaryCdnRoot, glm.artifactPath)), {
      recursive: true,
    });
    await writeFile(
      join(primaryCdnRoot, glm.artifactPath),
      "stale primary CDN bytes with a checksum mismatch",
      "utf8",
    );
    const primaryCdnServer = await createStaticFileServer(primaryCdnRoot);
    const backupCdnServer = await createStaticFileServer(backupCdnRoot);

    try {
      const backend = new FakeRemoteBackend(
        createFullyDeployedRemoteFiles("linux-arm64"),
      );
      await deployServer(
        backend,
        { platform: "linux", arch: "arm64" },
        {
          remoteCdnBaseUrls: [
            primaryCdnServer.baseUrl,
            backupCdnServer.baseUrl,
          ],
          remoteCacheDir,
        },
      );

      expect(
        hasUploadForStagingTarget(
          backend,
          "~/.zcode/server/agents/glm/zcode.cjs.new",
        ),
      ).toBe(true);
      expect(
        primaryCdnServer.getRequestCount(
          toComponentArtifactRequestPath(glm.artifactPath),
        ),
      ).toBe(0);
      expect(
        backupCdnServer.getRequestCount(
          toComponentArtifactRequestPath(glm.artifactPath),
        ),
      ).toBe(1);
    } finally {
      await primaryCdnServer.close();
      await backupCdnServer.close();
    }
  });

  it("生产态 manifest 缺失时不应再回退 legacy remote-assets 归档", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-remote-deploy-"));
    tempDirs.push(rootDir);

    const mockCdnDir = join(rootDir, "mock-cdn");
    const cdnRoot = join(rootDir, "cdn");
    const remoteCacheDir = join(rootDir, "remote-cache");
    await stageRemoteRuntimeRelease(mockCdnDir);
    const manifest = await stageRemoteComponentArtifacts(mockCdnDir, cdnRoot, {
      writeManifest: false,
    });
    await stageRemoteAssetArchive(mockCdnDir, cdnRoot, {
      useLegacyFileName: true,
    });
    const cdnServer = await createStaticFileServer(cdnRoot);
    const serverBundle = manifest.components.find(
      (component) => component.id === "server-bundle",
    );
    if (!serverBundle) {
      throw new Error("missing server-bundle component in staged manifest");
    }

    try {
      await expect(
        deployServer(
          new FakeRemoteBackend({
            "~/.zcode/server/agents/codex/.version": "0.0.0\n",
          }),
          { platform: "linux", arch: "arm64" },
          {
            force: false,
            remoteCdnBaseUrl: cdnServer.baseUrl,
            remoteCacheDir,
          },
        ),
      ).rejects.toThrow(/manifest not found/u);
      expect(
        cdnServer.getRequestCount(
          `/${ZCODE_VERSION}/manifest-linux-arm64.json`,
        ),
      ).toBe(1);
      expect(
        cdnServer.getRequestCount(
          toVersionedArtifactRequestPath(serverBundle.artifactPath),
        ),
      ).toBe(0);
      expect(
        cdnServer.getRequestCount(
          `/${ZCODE_VERSION}/remote-assets-linux-arm64.tar.gz`,
        ),
      ).toBe(0);
      expect(
        cdnServer.getRequestCount(`/${ZCODE_VERSION}/remote-assets.tar.gz`),
      ).toBe(0);
    } finally {
      await cdnServer.close();
    }
  });

  it("生产态 cache 命中时不应重复下载组件产物", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-remote-deploy-"));
    tempDirs.push(rootDir);

    const mockCdnDir = join(rootDir, "mock-cdn");
    const cdnRoot = join(rootDir, "cdn");
    const remoteCacheDir = join(rootDir, "remote-cache");
    await stageRemoteRuntimeRelease(mockCdnDir);
    const manifest = await stageRemoteComponentArtifacts(mockCdnDir, cdnRoot);
    const cdnServer = await createStaticFileServer(cdnRoot);
    const ripgrepBundle = manifest.components.find(
      (component) => component.id === "ripgrep",
    );
    if (!ripgrepBundle) {
      throw new Error("missing ripgrep component in staged manifest");
    }

    try {
      await deployServer(
        new FakeRemoteBackend({
          "~/.zcode/server/agents/codex/.version": "0.0.0\n",
        }),
        { platform: "linux", arch: "arm64" },
        {
          force: false,
          remoteCdnBaseUrl: cdnServer.baseUrl,
          remoteCacheDir,
          resourcePackages: {
            selectedPackageIds: [`${retiredProtocolPrefix}-codex`],
          },
        },
      );
      await deployServer(
        new FakeRemoteBackend({
          "~/.zcode/server/agents/codex/.version": "0.0.0\n",
        }),
        { platform: "linux", arch: "arm64" },
        {
          force: false,
          remoteCdnBaseUrl: cdnServer.baseUrl,
          remoteCacheDir,
          resourcePackages: {
            selectedPackageIds: [`${retiredProtocolPrefix}-codex`],
          },
        },
      );

      expect(
        cdnServer.getRequestCount(
          toVersionedArtifactRequestPath(ripgrepBundle.artifactPath),
        ),
      ).toBe(0);
      expect(
        cdnServer.getRequestCount(
          toComponentArtifactRequestPath(ripgrepBundle.artifactPath),
        ),
      ).toBe(1);
    } finally {
      await cdnServer.close();
    }
  });

  it("生产态主 server 过期时应同时刷新 glm bundle", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-remote-deploy-"));
    tempDirs.push(rootDir);

    const mockCdnDir = join(rootDir, "mock-cdn");
    const cdnRoot = join(rootDir, "cdn");
    const remoteCacheDir = join(rootDir, "remote-cache");
    await stageRemoteRuntimeRelease(mockCdnDir);
    const manifest = await stageRemoteComponentArtifacts(mockCdnDir, cdnRoot);
    const cdnServer = await createStaticFileServer(cdnRoot);

    try {
      const backend = new FakeRemoteBackend(
        {
          ...createFullyDeployedRemoteFiles("linux-arm64"),
          "~/.zcode/server/.asset-components/node-runtime.json":
            createRemoteAssetComponentMeta(
              "node-runtime",
              findManifestComponent(manifest, "node-runtime").version,
              "linux-arm64",
            ),
          "~/.zcode/server/.asset-components/node-pty.json":
            createRemoteAssetComponentMeta(
              "node-pty",
              findManifestComponent(manifest, "node-pty").version,
              "linux-arm64",
            ),
        },
        {
          serverVersion: "1.9.0",
        },
      );
      const deployed = await deployServer(
        backend,
        { platform: "linux", arch: "arm64" },
        {
          force: false,
          remoteCdnBaseUrl: cdnServer.baseUrl,
          remoteCacheDir,
        },
      );

      expect(deployed).toBe(true);
      expect(backend.uploads).toHaveLength(3);
      expect(backend.uploads.map((upload) => upload.remotePath)).toEqual(
        expect.arrayContaining([
          expect.stringMatching(
            /^~\/.zcode\/server\/zcode-server\.cjs\.new-[\w-]+$/u,
          ),
          expect.stringMatching(
            /^~\/.zcode\/server\/agents\/glm\/zcode\.cjs\.new-[\w-]+$/u,
          ),
          expect.stringMatching(
            /^~\/.zcode\/server\/agents\/glm\/packages\.tar\.gz-[\w-]+$/u,
          ),
        ]),
      );
      expect(
        cdnServer.getRequestCount(
          `/${ZCODE_VERSION}/manifest-linux-arm64.json`,
        ),
      ).toBe(1);
      for (const componentId of ["server-bundle"]) {
        expect(
          cdnServer.getRequestCount(
            toVersionedArtifactRequestPath(
              findManifestComponent(manifest, componentId).artifactPath,
            ),
          ),
        ).toBe(0);
        expect(
          cdnServer.getRequestCount(
            toComponentArtifactRequestPath(
              findManifestComponent(manifest, componentId).artifactPath,
            ),
          ),
        ).toBe(1);
      }
      for (const componentId of [
        "node-runtime",
        "node-pty",
        `${retiredProtocolPrefix}-codex`,
        "glm",
        "ripgrep",
      ]) {
        expect(
          cdnServer.getRequestCount(
            toVersionedArtifactRequestPath(
              findManifestComponent(manifest, componentId).artifactPath,
            ),
          ),
        ).toBe(0);
      }
    } finally {
      await cdnServer.close();
    }
  });

  it("local-download-upload 下 App 版本变化时即使 server-bundle 与 GLM SHA cache 命中也应重新下载上传", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-remote-deploy-"));
    tempDirs.push(rootDir);

    const mockCdnDir = join(rootDir, "mock-cdn");
    const cdnRoot = join(rootDir, "cdn");
    const remoteCacheDir = join(rootDir, "remote-cache");
    await stageRemoteRuntimeRelease(mockCdnDir);
    const manifest = await stageRemoteComponentArtifacts(mockCdnDir, cdnRoot);
    const cdnServer = await createStaticFileServer(cdnRoot);
    const serverBundle = findManifestComponent(manifest, "server-bundle");
    const glm = findManifestComponent(manifest, "glm");

    try {
      const warmCacheBackend = new FakeRemoteBackend(
        createFullyDeployedRemoteFiles("linux-arm64"),
      );
      await deployServer(
        warmCacheBackend,
        { platform: "linux", arch: "arm64" },
        {
          force: false,
          remoteCdnBaseUrl: cdnServer.baseUrl,
          remoteCacheDir,
        },
      );
      expect(
        cdnServer.getRequestCount(
          toComponentArtifactRequestPath(serverBundle.artifactPath),
        ),
      ).toBe(1);
      expect(
        cdnServer.getRequestCount(
          toComponentArtifactRequestPath(glm.artifactPath),
        ),
      ).toBe(1);

      const remoteFiles = createFullyDeployedRemoteFiles("linux-arm64");
      addMatchingGlmAndServerArtifactIdentities(
        remoteFiles,
        manifest,
        "linux-arm64",
      );
      remoteFiles["~/.zcode/server/.asset-components/node-runtime.json"] =
        createRemoteAssetComponentMeta(
          "node-runtime",
          findManifestComponent(manifest, "node-runtime").version,
          "linux-arm64",
        );
      remoteFiles["~/.zcode/server/.asset-components/node-pty.json"] =
        createRemoteAssetComponentMeta(
          "node-pty",
          findManifestComponent(manifest, "node-pty").version,
          "linux-arm64",
        );
      const backend = new FakeRemoteBackend(remoteFiles, {
        serverVersion: "3.4.0-old-app",
      });

      const deployed = await deployServer(
        backend,
        { platform: "linux", arch: "arm64" },
        {
          force: false,
          remoteCdnBaseUrl: cdnServer.baseUrl,
          remoteCacheDir,
        },
      );

      expect(deployed).toBe(true);
      expect(
        cdnServer.getRequestCount(
          toComponentArtifactRequestPath(serverBundle.artifactPath),
        ),
      ).toBe(2);
      expect(
        cdnServer.getRequestCount(
          toComponentArtifactRequestPath(glm.artifactPath),
        ),
      ).toBe(2);
      expect(
        hasUploadForStagingTarget(
          backend,
          "~/.zcode/server/agents/glm/zcode.cjs.new",
        ),
      ).toBe(true);
      expect(
        hasUploadForStagingTarget(
          backend,
          "~/.zcode/server/agents/glm/packages.tar.gz",
        ),
      ).toBe(true);
    } finally {
      await cdnServer.close();
    }
  });

  it("App 版本变化后 GLM 部署失败时下次连接应继续强制刷新 cache", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-remote-deploy-"));
    tempDirs.push(rootDir);

    const mockCdnDir = join(rootDir, "mock-cdn");
    const cdnRoot = join(rootDir, "cdn");
    const remoteCacheDir = join(rootDir, "remote-cache");
    await stageRemoteRuntimeRelease(mockCdnDir);
    const manifest = await stageRemoteComponentArtifacts(mockCdnDir, cdnRoot);
    const cdnServer = await createStaticFileServer(cdnRoot);
    const glm = findManifestComponent(manifest, "glm");
    const remoteFiles = createFullyDeployedRemoteFiles("linux-arm64");
    addMatchingGlmAndServerArtifactIdentities(
      remoteFiles,
      manifest,
      "linux-arm64",
    );
    remoteFiles["~/.zcode/server/.asset-components/node-runtime.json"] =
      createRemoteAssetComponentMeta(
        "node-runtime",
        findManifestComponent(manifest, "node-runtime").version,
        "linux-arm64",
      );
    remoteFiles["~/.zcode/server/.asset-components/node-pty.json"] =
      createRemoteAssetComponentMeta(
        "node-pty",
        findManifestComponent(manifest, "node-pty").version,
        "linux-arm64",
      );
    let remoteServerVersion = "3.4.0-old-app";
    let backend: FailFirstGlmUploadRemoteBackend;
    backend = new FailFirstGlmUploadRemoteBackend(remoteFiles, {
      serverVersion: () => remoteServerVersion,
      commandPlans: [
        {
          matcher: /command mv -f .*zcode-server\.cjs\.new.*zcode-server\.cjs/u,
          exitCode: 0,
          onExec: () => {
            remoteServerVersion = ZCODE_VERSION;
          },
        },
        {
          matcher: /pendingRefreshAppVersion/u,
          exitCode: 0,
          onExec: () => {
            backend.remoteFiles.set(
              "~/.zcode/server/.asset-components/glm.json",
              JSON.stringify({
                id: "glm",
                platformArch: "linux-arm64",
                pendingRefreshAppVersion: ZCODE_VERSION,
              }),
            );
          },
        },
      ],
    });

    try {
      await expect(
        deployServer(
          backend,
          { platform: "linux", arch: "arm64" },
          {
            force: false,
            remoteCdnBaseUrl: cdnServer.baseUrl,
            remoteCacheDir,
          },
        ),
      ).rejects.toThrow("mock glm upload failed");
      expect(remoteServerVersion).toBe(ZCODE_VERSION);
      expect(
        backend.remoteFiles.get(
          "~/.zcode/server/.asset-components/glm.json",
        ),
      ).toContain("pendingRefreshAppVersion");
      expect(
        cdnServer.getRequestCount(
          toComponentArtifactRequestPath(glm.artifactPath),
        ),
      ).toBe(1);
      const firstAttemptCommands = backend.commands.slice();
      const refreshPendingCommandIndex = firstAttemptCommands.findIndex(
        (command) => command.includes("pendingRefreshAppVersion"),
      );
      const serverReplaceCommandIndex = firstAttemptCommands.findIndex(
        (command) =>
          command.includes("command mv -f ") &&
          command.includes("zcode-server.cjs.new"),
      );
      expect(refreshPendingCommandIndex).toBeGreaterThanOrEqual(0);
      expect(serverReplaceCommandIndex).toBeGreaterThan(
        refreshPendingCommandIndex,
      );
      expect(
        firstAttemptCommands.some(
          (command) =>
            !command.includes("pendingRefreshAppVersion") &&
            command.includes(".asset-components/glm.json"),
        ),
      ).toBe(false);

      const deployed = await deployServer(
        backend,
        { platform: "linux", arch: "arm64" },
        {
          force: false,
          remoteCdnBaseUrl: cdnServer.baseUrl,
          remoteCacheDir,
        },
      );

      expect(deployed).toBe(false);
      expect(
        cdnServer.getRequestCount(
          toComponentArtifactRequestPath(glm.artifactPath),
        ),
      ).toBe(2);
      expect(
        hasUploadForStagingTarget(
          backend,
          "~/.zcode/server/agents/glm/zcode.cjs.new",
        ),
      ).toBe(true);
      expect(
        hasUploadForStagingTarget(
          backend,
          "~/.zcode/server/agents/glm/packages.tar.gz",
        ),
      ).toBe(true);
      expect(
        backend.commands
          .slice(firstAttemptCommands.length)
          .some(
            (command) =>
              !command.includes("pendingRefreshAppVersion") &&
              command.includes(".asset-components/glm.json"),
          ),
      ).toBe(true);
    } finally {
      await cdnServer.close();
    }
  });

  it("remote-download 下 App 版本变化时即使 server-bundle 与 GLM SHA 匹配也应重新下载部署", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-remote-deploy-"));
    tempDirs.push(rootDir);

    const mockCdnDir = join(rootDir, "mock-cdn");
    const cdnRoot = join(rootDir, "cdn");
    await stageRemoteRuntimeRelease(mockCdnDir);
    const manifest = await stageRemoteComponentArtifacts(mockCdnDir, cdnRoot);
    const cdnServer = await createStaticFileServer(cdnRoot);
    const serverBundle = findManifestComponent(manifest, "server-bundle");
    const glm = findManifestComponent(manifest, "glm");
    const serverBundleCacheDir = `~/.zcode/server/asset-cache/components/linux-arm64/server-bundle/${serverBundle.sha256}`;
    const glmCacheDir = `~/.zcode/server/asset-cache/components/linux-arm64/glm/${glm.sha256}`;
    const remoteFiles = createFullyDeployedRemoteFiles("linux-arm64");
    addMatchingGlmAndServerArtifactIdentities(
      remoteFiles,
      manifest,
      "linux-arm64",
    );
    remoteFiles[`${serverBundleCacheDir}/.ready`] = "ready";
    remoteFiles[`${glmCacheDir}/.ready`] = "ready";
    remoteFiles["~/.zcode/server/.asset-components/node-runtime.json"] =
      createRemoteAssetComponentMeta(
        "node-runtime",
        findManifestComponent(manifest, "node-runtime").version,
        "linux-arm64",
      );
    remoteFiles["~/.zcode/server/.asset-components/node-pty.json"] =
      createRemoteAssetComponentMeta(
        "node-pty",
        findManifestComponent(manifest, "node-pty").version,
        "linux-arm64",
      );
    const backend = new FakeRemoteBackend(remoteFiles, {
      serverVersion: "3.4.0-old-app",
      commandPlans: [
        {
          matcher: /command -v curl/u,
          exitCode: 0,
          stdoutText: "download=curl\ntar=tar\nsha256=sha256sum\n",
        },
      ],
    });

    try {
      const deployed = await deployServer(
        backend,
        { platform: "linux", arch: "arm64" },
        {
          force: false,
          assetInstallMode: "remote-download",
          remoteCdnBaseUrl: cdnServer.baseUrl,
        },
      );

      expect(deployed).toBe(true);
      expect(backend.uploads).toEqual([]);
      expect(
        backend.commands.filter((command) =>
          command.includes(serverBundle.artifactPath),
        ),
      ).toHaveLength(1);
      expect(
        backend.commands.some((command) =>
          command.includes(
            `rm -rf "$HOME"'/.zcode/server/asset-cache/components/linux-arm64/server-bundle/${serverBundle.sha256}'`,
          ),
        ),
      ).toBe(true);
      expect(
        backend.commands.some((command) => command.includes(glm.artifactPath)),
      ).toBe(true);
      expect(
        backend.commands.filter((command) =>
          command.includes(glm.artifactPath),
        ),
      ).toHaveLength(1);
      expect(
        backend.commands.some((command) =>
          command.includes(
            `rm -rf "$HOME"'/.zcode/server/asset-cache/components/linux-arm64/glm/${glm.sha256}'`,
          ),
        ),
      ).toBe(true);
      expect(
        backend.commands.some((command) =>
          command.includes(".asset-components/glm.json"),
        ),
      ).toBe(true);
    } finally {
      await cdnServer.close();
    }
  });

  it("remote-download 下 App 版本变化后中间部署失败时应在重试中继续强刷 GLM cache", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-remote-deploy-"));
    tempDirs.push(rootDir);

    const mockCdnDir = join(rootDir, "mock-cdn");
    const cdnRoot = join(rootDir, "cdn");
    await stageRemoteRuntimeRelease(mockCdnDir);
    const manifest = await stageRemoteComponentArtifacts(mockCdnDir, cdnRoot);
    const cdnServer = await createStaticFileServer(cdnRoot);
    const serverBundle = findManifestComponent(manifest, "server-bundle");
    const glm = findManifestComponent(manifest, "glm");
    const remoteFiles = createFullyDeployedRemoteFiles("linux-arm64");
    addMatchingGlmAndServerArtifactIdentities(
      remoteFiles,
      manifest,
      "linux-arm64",
    );
    remoteFiles[
      `~/.zcode/server/asset-cache/components/linux-arm64/server-bundle/${serverBundle.sha256}/.ready`
    ] = "ready";
    remoteFiles[
      `~/.zcode/server/asset-cache/components/linux-arm64/glm/${glm.sha256}/.ready`
    ] = "ready";
    remoteFiles["~/.zcode/server/.asset-components/node-runtime.json"] =
      createRemoteAssetComponentMeta(
        "node-runtime",
        findManifestComponent(manifest, "node-runtime").version,
        "linux-arm64",
      );
    let remoteServerVersion = "3.4.0-old-app";
    let backend: FailFirstNodePtyInstallRemoteBackend;
    backend = new FailFirstNodePtyInstallRemoteBackend(remoteFiles, {
      serverVersion: () => remoteServerVersion,
      commandPlans: [
        {
          matcher: /command -v curl/u,
          exitCode: 0,
          stdoutText: "download=curl\ntar=tar\nsha256=sha256sum\n",
        },
        {
          matcher: /command mv -f .*zcode-server\.cjs\.new.*zcode-server\.cjs/u,
          exitCode: 0,
          onExec: () => {
            remoteServerVersion = ZCODE_VERSION;
          },
        },
        {
          matcher: /pendingRefreshAppVersion/u,
          exitCode: 0,
          onExec: () => {
            backend.remoteFiles.set(
              "~/.zcode/server/.asset-components/glm.json",
              JSON.stringify({
                id: "glm",
                platformArch: "linux-arm64",
                pendingRefreshAppVersion: ZCODE_VERSION,
              }),
            );
          },
        },
      ],
    });

    try {
      await expect(
        deployServer(
          backend,
          { platform: "linux", arch: "arm64" },
          {
            assetInstallMode: "remote-download",
            remoteCdnBaseUrl: cdnServer.baseUrl,
          },
        ),
      ).rejects.toThrow("mock node-pty install failed");
      expect(remoteServerVersion).toBe(ZCODE_VERSION);
      expect(
        backend.commands.some((command) =>
          command.includes(glm.artifactPath),
        ),
      ).toBe(false);

      const deployed = await deployServer(
        backend,
        { platform: "linux", arch: "arm64" },
        {
          assetInstallMode: "remote-download",
          remoteCdnBaseUrl: cdnServer.baseUrl,
        },
      );

      expect(deployed).toBe(false);
      expect(
        backend.commands.filter((command) =>
          command.includes(glm.artifactPath),
        ),
      ).toHaveLength(1);
      expect(
        backend.commands.some((command) =>
          command.includes(
            `rm -rf "$HOME"'/.zcode/server/asset-cache/components/linux-arm64/glm/${glm.sha256}'`,
          ),
        ),
      ).toBe(true);
    } finally {
      await cdnServer.close();
    }
  });

  it("开发态 mock-cdn 有匹配组件版本时主 server 过期不应重传 node runtime", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-remote-deploy-"));
    tempDirs.push(rootDir);

    const mockCdnDir = join(rootDir, "mock-cdn");
    await stageRemoteRuntimeRelease(mockCdnDir);
    const manifest = await stageRemoteComponentArtifacts(
      mockCdnDir,
      join(mockCdnDir, "releases"),
    );
    const nodeRuntime = manifest.components.find(
      (component) => component.id === "node-runtime",
    );
    if (!nodeRuntime) {
      throw new Error("missing node-runtime component in staged manifest");
    }
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const backend = new FakeRemoteBackend(
        {
          ...createFullyDeployedRemoteFiles("linux-arm64"),
          "~/.zcode/server/.asset-components/node-runtime.json":
            createRemoteAssetComponentMeta(
              "node-runtime",
              nodeRuntime.version,
              "linux-arm64",
            ),
        },
        {
          serverVersion: "1.9.0",
        },
      );

      await deployServer(
        backend,
        { platform: "linux", arch: "arm64" },
        {
          force: false,
          mockCdnDir,
        },
      );

      expect(backend.uploads.map((upload) => upload.remotePath)).not.toContain(
        "~/.zcode/server/node.new",
      );
      const warnLines = warnSpy.mock.calls.map((args) =>
        args.map((arg) => String(arg)).join(" "),
      );
      expect(
        warnLines.some(
          (line) =>
            line.includes("component=node-runtime") &&
            line.includes("component version unavailable"),
        ),
      ).toBe(false);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("生产态主 server 过期但 node 版本不匹配时应记录原因并重传 node", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-remote-deploy-"));
    tempDirs.push(rootDir);

    const mockCdnDir = join(rootDir, "mock-cdn");
    const cdnRoot = join(rootDir, "cdn");
    const remoteCacheDir = join(rootDir, "remote-cache");
    await stageRemoteRuntimeRelease(mockCdnDir);
    const manifest = await stageRemoteComponentArtifacts(mockCdnDir, cdnRoot);
    const cdnServer = await createStaticFileServer(cdnRoot);
    const nodeRuntime = manifest.components.find(
      (component) => component.id === "node-runtime",
    );
    if (!nodeRuntime) {
      throw new Error("missing node-runtime component in staged manifest");
    }

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const backend = new FakeRemoteBackend(
        {
          ...createFullyDeployedRemoteFiles("linux-arm64"),
          "~/.zcode/server/.asset-components/node-runtime.json":
            createRemoteAssetComponentMeta(
              "node-runtime",
              "old-node-version",
              "linux-arm64",
            ),
          "~/.zcode/server/.asset-components/node-pty.json":
            createRemoteAssetComponentMeta(
              "node-pty",
              "1.0.0-node-pty",
              "linux-arm64",
            ),
        },
        {
          serverVersion: "1.9.0",
        },
      );

      await deployServer(
        backend,
        { platform: "linux", arch: "arm64" },
        {
          force: false,
          remoteCdnBaseUrl: cdnServer.baseUrl,
          remoteCacheDir,
        },
      );

      expect(
        hasUploadForStagingTarget(backend, "~/.zcode/server/node.new"),
      ).toBe(true);
      expect(
        cdnServer.getRequestCount(
          toVersionedArtifactRequestPath(nodeRuntime.artifactPath),
        ),
      ).toBe(0);
      expect(
        cdnServer.getRequestCount(
          toComponentArtifactRequestPath(nodeRuntime.artifactPath),
        ),
      ).toBe(1);
      const warnLines = warnSpy.mock.calls.map((args) =>
        args.map((arg) => String(arg)).join(" "),
      );
      expect(
        warnLines.some(
          (line) =>
            line.includes("[remote-assets] upload required") &&
            line.includes("component=node-runtime") &&
            line.includes("remote version mismatch") &&
            line.includes("old-node-version"),
        ),
      ).toBe(true);
    } finally {
      warnSpy.mockRestore();
      await cdnServer.close();
    }
  });

  it("版本匹配但 runtime tool binary 缺失时应补传并记录原因", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-remote-deploy-"));
    tempDirs.push(rootDir);
    const mockCdnDir = join(rootDir, "mock-cdn");
    await stageRemoteRuntimeRelease(mockCdnDir);

    const remoteFiles = createFullyDeployedRemoteFiles("linux-arm64");
    delete remoteFiles["~/.zcode/server/tools/ripgrep/rg"];
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const backend = new FakeRemoteBackend(remoteFiles);

      await deployServer(
        backend,
        { platform: "linux", arch: "arm64" },
        {
          force: false,
          mockCdnDir,
        },
      );

      expect(
        hasUploadForStagingTarget(
          backend,
          "~/.zcode/server/tools/ripgrep/rg.new",
        ),
      ).toBe(true);
      const warnLines = warnSpy.mock.calls.map((args) =>
        args.map((arg) => String(arg)).join(" "),
      );
      expect(
        warnLines.some(
          (line) =>
            line.includes("[remote-assets] upload required") &&
            line.includes("component=ripgrep") &&
            line.includes("remote binary missing"),
        ),
      ).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("主 server 版本匹配但 glm wrapper 缺失时应补传", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-remote-deploy-"));
    tempDirs.push(rootDir);
    const mockCdnDir = join(rootDir, "mock-cdn");
    await stageRemoteRuntimeRelease(mockCdnDir);
    const manifest = await stageRemoteComponentArtifacts(
      mockCdnDir,
      join(mockCdnDir, "releases"),
    );

    const remoteFiles = createFullyDeployedRemoteFiles("linux-arm64");
    addMatchingGlmAndServerArtifactIdentities(
      remoteFiles,
      manifest,
      "linux-arm64",
    );
    delete remoteFiles["~/.zcode/server/agents/glm/zcode-agent"];
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const backend = new FakeRemoteBackend(remoteFiles);

      await deployServer(
        backend,
        { platform: "linux", arch: "arm64" },
        {
          force: false,
          mockCdnDir,
        },
      );

      expect(
        hasUploadForStagingTarget(
          backend,
          "~/.zcode/server/agents/glm/zcode.cjs.new",
        ),
      ).toBe(true);
      const warnLines = warnSpy.mock.calls.map((args) =>
        args.map((arg) => String(arg)).join(" "),
      );
      expect(
        warnLines.some(
          (line) =>
            line.includes("[remote-assets] upload required") &&
            line.includes("component=glm") &&
            line.includes("remote wrapper missing"),
        ),
      ).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("主 server 版本匹配且 glm SHA 相同但版本不同时不应补传", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-remote-deploy-"));
    tempDirs.push(rootDir);
    const mockCdnDir = join(rootDir, "mock-cdn");
    await stageRemoteRuntimeRelease(mockCdnDir);
    const manifest = await stageRemoteComponentArtifacts(
      mockCdnDir,
      join(mockCdnDir, "releases"),
    );

    const remoteFiles = createFullyDeployedRemoteFiles("linux-arm64");
    addMatchingGlmAndServerArtifactIdentities(
      remoteFiles,
      manifest,
      "linux-arm64",
      "0.0.1-old-version",
    );
    const backend = new FakeRemoteBackend(remoteFiles);

    await deployServer(
      backend,
      { platform: "linux", arch: "arm64" },
      {
        force: false,
        mockCdnDir,
      },
    );

    expect(
      hasUploadForStagingTarget(
        backend,
        "~/.zcode/server/agents/glm/zcode.cjs.new",
      ),
    ).toBe(false);
    expect(
      backend.commands.some((command) =>
        command.includes(".asset-components/glm.json"),
      ),
    ).toBe(false);
    expect(
      backend.uploads.some(
        (upload) =>
          upload.remotePath === "~/.zcode/server/agents/opencode/opencode.new",
      ),
    ).toBe(false);
  });

  it("生产态远端 GLM SHA 匹配时只读取 manifest 而不下载制品", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-remote-deploy-"));
    tempDirs.push(rootDir);

    const mockCdnDir = join(rootDir, "mock-cdn");
    const cdnRoot = join(rootDir, "cdn");
    const remoteCacheDir = join(rootDir, "remote-cache");
    await stageRemoteRuntimeRelease(mockCdnDir);
    const manifest = await stageRemoteComponentArtifacts(mockCdnDir, cdnRoot);
    const cdnServer = await createStaticFileServer(cdnRoot);

    try {
      const remoteFiles = createFullyDeployedRemoteFiles("linux-arm64");
      addMatchingGlmAndServerArtifactIdentities(
        remoteFiles,
        manifest,
        "linux-arm64",
      );
      const backend = new FakeRemoteBackend(remoteFiles);
      const deployed = await deployServer(
        backend,
        { platform: "linux", arch: "arm64" },
        {
          force: false,
          remoteCdnBaseUrl: cdnServer.baseUrl,
          remoteCacheDir,
        },
      );

      expect(deployed).toBe(false);
      expect(backend.uploads).toEqual([]);
      expect(
        cdnServer.getRequestCount(
          `/${ZCODE_VERSION}/manifest-linux-arm64.json`,
        ),
      ).toBe(1);
      const glm = manifest.components.find(
        (component) => component.id === "glm",
      );
      if (!glm) {
        throw new Error("missing glm component in staged manifest");
      }
      expect(
        cdnServer.getRequestCount(
          toComponentArtifactRequestPath(glm.artifactPath),
        ),
      ).toBe(0);
      expect(
        cdnServer.getRequestCount(
          `/${ZCODE_VERSION}/remote-assets-linux-arm64.tar.gz`,
        ),
      ).toBe(0);
    } finally {
      await cdnServer.close();
    }
  });

  it("远端已部署时 manifest 响应超时应有界失败且允许下一次连接重试", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-remote-deploy-"));
    tempDirs.push(rootDir);

    const cdnRoot = join(rootDir, "cdn");
    const remoteCacheDir = join(rootDir, "remote-cache");
    const manifestPath = `/${ZCODE_VERSION}/manifest-linux-arm64.json`;
    const cdnServer = await createStaticFileServer(cdnRoot, {
      stalledPaths: [manifestPath],
    });
    const backend = new FakeRemoteBackend(
      createFullyDeployedRemoteFiles("linux-arm64"),
    );
    const logWarn = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);

    try {
      let previousRequestCount = 0;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const startedAt = Date.now();
        await expect(
          deployServer(
            backend,
            { platform: "linux", arch: "arm64" },
            {
              remoteCdnBaseUrl: cdnServer.baseUrl,
              remoteCacheDir,
              manifestRequestTimeoutMs: 25,
            },
          ),
        ).rejects.toThrow(/failed to fetch manifest-linux-arm64\.json/u);
        expect(Date.now() - startedAt).toBeLessThan(1_000);
        const requestCount = cdnServer.getRequestCount(manifestPath);
        expect(requestCount).toBeGreaterThan(previousRequestCount);
        previousRequestCount = requestCount;
      }

      expect(
        logWarn.mock.calls.some((args) =>
          args.some((arg) => String(arg).includes("TimeoutError")),
        ),
      ).toBe(true);
      expect(backend.uploads).toEqual([]);
    } finally {
      logWarn.mockRestore();
      await cdnServer.close();
    }
  });

  it("首次部署的 manifest 超时不应在锁内降级重拉", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-remote-deploy-"));
    tempDirs.push(rootDir);
    const cdnRoot = join(rootDir, "cdn");
    const remoteCacheDir = join(rootDir, "remote-cache");
    const manifestPath = `/${ZCODE_VERSION}/manifest-linux-arm64.json`;
    const cdnServer = await createStaticFileServer(cdnRoot, {
      stalledPaths: [manifestPath],
    });
    const backend = new FakeRemoteBackend({});

    try {
      const startedAt = Date.now();
      await expect(
        deployServer(
          backend,
          { platform: "linux", arch: "arm64" },
          {
            remoteCdnBaseUrl: cdnServer.baseUrl,
            remoteCacheDir,
            manifestRequestTimeoutMs: 25,
          },
        ),
      ).rejects.toThrow(/failed to fetch manifest-linux-arm64\.json/u);
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      // Bugfix：pinned manifest 失败就是本次 transaction 的失败，
      // 不能再走 version resolver 发起第二个默认 10s 请求。
      expect(cdnServer.getRequestCount(manifestPath)).toBe(1);
    } finally {
      await cdnServer.close();
    }
  });

  it("component version resolver 应透传 manifest request deadline", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-remote-deploy-"));
    tempDirs.push(rootDir);
    const cdnRoot = join(rootDir, "cdn");
    const remoteCacheDir = join(rootDir, "remote-cache");
    const manifestPath = `/${ZCODE_VERSION}/manifest-linux-arm64.json`;
    const cdnServer = await createStaticFileServer(cdnRoot, {
      stalledPaths: [manifestPath],
    });

    try {
      const resolveVersion = createRemoteComponentVersionResolver(
        {
          remoteCdnBaseUrl: cdnServer.baseUrl,
          remoteCacheDir,
          manifestRequestTimeoutMs: 25,
        },
        { platform: "linux", arch: "arm64" },
        { log: () => {}, logWarn: () => {} },
      );
      const startedAt = Date.now();
      await expect(resolveVersion("node-runtime")).rejects.toThrow(
        /failed to fetch manifest-linux-arm64\.json/u,
      );
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      expect(cdnServer.getRequestCount(manifestPath)).toBe(1);
    } finally {
      await cdnServer.close();
    }
  });

  it("remote-download manifest 超时应保留 CDN 候选诊断", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-remote-deploy-"));
    tempDirs.push(rootDir);
    const cdnRoot = join(rootDir, "cdn");
    const manifestPath = `/${ZCODE_VERSION}/manifest-linux-arm64.json`;
    const cdnServer = await createStaticFileServer(cdnRoot, {
      stalledPaths: [manifestPath],
    });

    try {
      await expect(
        fetchRemoteDownloadManifest(
          {
            version: ZCODE_VERSION,
            platformArch: "linux-arm64",
            remoteCdnBaseUrl: cdnServer.baseUrl,
            manifestRequestTimeoutMs: 25,
          },
          { log: () => {}, logWarn: () => {} },
        ),
      ).rejects.toThrow(/failed to fetch manifest.*TimeoutError/u);
      expect(cdnServer.getRequestCount(manifestPath)).toBe(1);
    } finally {
      await cdnServer.close();
    }
  });

  it("同一进程内 GLM 版本不变但 manifest SHA 更新时应重新部署", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-remote-deploy-"));
    tempDirs.push(rootDir);

    const mockCdnDir = join(rootDir, "mock-cdn");
    const cdnRoot = join(rootDir, "cdn");
    const remoteCacheDir = join(rootDir, "remote-cache");
    await stageRemoteRuntimeRelease(mockCdnDir);
    const initialManifest = await stageRemoteComponentArtifacts(
      mockCdnDir,
      cdnRoot,
    );
    const remoteFiles = createFullyDeployedRemoteFiles("linux-arm64");
    addMatchingGlmAndServerArtifactIdentities(
      remoteFiles,
      initialManifest,
      "linux-arm64",
    );
    const backend = new FakeRemoteBackend(remoteFiles);
    const cdnServer = await createStaticFileServer(cdnRoot);

    try {
      await deployServer(
        backend,
        { platform: "linux", arch: "arm64" },
        {
          force: false,
          remoteCdnBaseUrl: cdnServer.baseUrl,
          remoteCacheDir,
        },
      );
      expect(backend.uploads).toEqual([]);

      await writeFile(
        join(
          mockCdnDir,
          "releases",
          ZCODE_VERSION,
          "glm",
          "linux-arm64",
          "zcode.cjs",
        ),
        "glm bundle republished with the same semantic version",
        "utf8",
      );
      const updatedManifest = await stageRemoteComponentArtifacts(
        mockCdnDir,
        cdnRoot,
      );
      const initialGlm = initialManifest.components.find(
        (component) => component.id === "glm",
      );
      const updatedGlm = updatedManifest.components.find(
        (component) => component.id === "glm",
      );
      expect(updatedGlm?.version).toBe(initialGlm?.version);
      expect(updatedGlm?.sha256).not.toBe(initialGlm?.sha256);

      await deployServer(
        backend,
        { platform: "linux", arch: "arm64" },
        {
          force: false,
          remoteCdnBaseUrl: cdnServer.baseUrl,
          remoteCacheDir,
        },
      );

      expect(
        hasUploadForStagingTarget(
          backend,
          "~/.zcode/server/agents/glm/zcode.cjs.new",
        ),
      ).toBe(true);
      expect(
        cdnServer.getRequestCount(
          `/${ZCODE_VERSION}/manifest-linux-arm64.json`,
        ),
      ).toBe(2);
    } finally {
      await cdnServer.close();
    }
  });

  it("同一 App 版本内 server-bundle SHA 更新时应下载并上传新制品", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-remote-deploy-"));
    tempDirs.push(rootDir);

    const mockCdnDir = join(rootDir, "mock-cdn");
    const cdnRoot = join(rootDir, "cdn");
    const remoteCacheDir = join(rootDir, "remote-cache");
    await stageRemoteRuntimeRelease(mockCdnDir);
    const initialManifest = await stageRemoteComponentArtifacts(
      mockCdnDir,
      cdnRoot,
    );
    const initialServer = findManifestComponent(
      initialManifest,
      "server-bundle",
    );
    const legacyServerCacheDir = join(
      remoteCacheDir,
      "components",
      "server-bundle",
      initialServer.version,
    );
    await mkdir(legacyServerCacheDir, { recursive: true });
    await writeFile(join(legacyServerCacheDir, ".ready"), "ready\n", "utf8");
    await writeFile(
      join(legacyServerCacheDir, "zcode-server.cjs"),
      "// stale semantic-version server cache\n",
      "utf8",
    );
    const remoteFiles = createFullyDeployedRemoteFiles("linux-arm64");
    addMatchingGlmArtifactIdentity(
      remoteFiles,
      initialManifest,
      "linux-arm64",
    );
    const backend = new FakeRemoteBackend(remoteFiles);
    const cdnServer = await createStaticFileServer(cdnRoot);

    try {
      await deployServer(
        backend,
        { platform: "linux", arch: "arm64" },
        { remoteCdnBaseUrl: cdnServer.baseUrl, remoteCacheDir },
      );
      expect(
        hasUploadForStagingTarget(
          backend,
          "~/.zcode/server/zcode-server.cjs.new",
        ),
      ).toBe(true);
      const initialServerUpload = findUploadForStagingTarget(
        backend,
        "~/.zcode/server/zcode-server.cjs.new",
      );
      await expect(
        readFile(initialServerUpload?.localPath ?? "", "utf8"),
      ).resolves.not.toContain("stale semantic-version server cache");
      backend.uploads.splice(0);
      addMatchingServerBundleArtifactIdentity(
        remoteFiles,
        initialManifest,
        "linux-arm64",
      );
      backend.remoteFiles.set(
        "~/.zcode/server/.asset-components/server-bundle.json",
        remoteFiles["~/.zcode/server/.asset-components/server-bundle.json"] ??
          "",
      );

      await writeFile(
        join(
          mockCdnDir,
          "releases",
          ZCODE_VERSION,
          "server",
          "zcode-server.cjs",
        ),
        "// server bundle republished under the same App version\n",
        "utf8",
      );
      const updatedManifest = await stageRemoteComponentArtifacts(
        mockCdnDir,
        cdnRoot,
      );
      const updatedServer = findManifestComponent(
        updatedManifest,
        "server-bundle",
      );
      expect(updatedServer.version).toBe(initialServer.version);
      expect(updatedServer.sha256).not.toBe(initialServer.sha256);

      await deployServer(
        backend,
        { platform: "linux", arch: "arm64" },
        { remoteCdnBaseUrl: cdnServer.baseUrl, remoteCacheDir },
      );

      const serverUpload = findUploadForStagingTarget(
        backend,
        "~/.zcode/server/zcode-server.cjs.new",
      );
      expect(serverUpload).toBeDefined();
      await expect(readFile(serverUpload?.localPath ?? "", "utf8")).resolves
        .toContain("server bundle republished under the same App version");
      expect(
        cdnServer.getRequestCount(
          toComponentArtifactRequestPath(updatedServer.artifactPath),
        ),
      ).toBe(2);
    } finally {
      await cdnServer.close();
    }
  });

  it("并发 GLM SHA 检查应共享一次 fresh manifest 请求", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-remote-deploy-"));
    tempDirs.push(rootDir);

    const mockCdnDir = join(rootDir, "mock-cdn");
    const cdnRoot = join(rootDir, "cdn");
    const remoteCacheDir = join(rootDir, "remote-cache");
    await stageRemoteRuntimeRelease(mockCdnDir);
    const manifest = await stageRemoteComponentArtifacts(mockCdnDir, cdnRoot);
    const createBackend = (): FakeRemoteBackend => {
      const remoteFiles = createFullyDeployedRemoteFiles("linux-arm64");
      addMatchingGlmAndServerArtifactIdentities(
        remoteFiles,
        manifest,
        "linux-arm64",
      );
      return new FakeRemoteBackend(remoteFiles);
    };
    const cdnServer = await createStaticFileServer(cdnRoot);

    try {
      await Promise.all([
        deployServer(
          createBackend(),
          { platform: "linux", arch: "arm64" },
          { remoteCdnBaseUrl: cdnServer.baseUrl, remoteCacheDir },
        ),
        deployServer(
          createBackend(),
          { platform: "linux", arch: "arm64" },
          { remoteCdnBaseUrl: cdnServer.baseUrl, remoteCacheDir },
        ),
      ]);

      expect(
        cdnServer.getRequestCount(
          `/${ZCODE_VERSION}/manifest-linux-arm64.json`,
        ),
      ).toBe(1);

      // warm cache 下的第二轮并发也只能创建一个 refresh task。
      await Promise.all([
        deployServer(
          createBackend(),
          { platform: "linux", arch: "arm64" },
          { remoteCdnBaseUrl: cdnServer.baseUrl, remoteCacheDir },
        ),
        deployServer(
          createBackend(),
          { platform: "linux", arch: "arm64" },
          { remoteCdnBaseUrl: cdnServer.baseUrl, remoteCacheDir },
        ),
      ]);
      expect(
        cdnServer.getRequestCount(
          `/${ZCODE_VERSION}/manifest-linux-arm64.json`,
        ),
      ).toBe(2);

      // remote-download 也必须让身份判断与实际安装共享同一个 manifest 请求。
      await Promise.all([
        deployServer(
          createBackend(),
          { platform: "linux", arch: "arm64" },
          {
            assetInstallMode: "remote-download",
            remoteCdnBaseUrl: cdnServer.baseUrl,
          },
        ),
        deployServer(
          createBackend(),
          { platform: "linux", arch: "arm64" },
          {
            assetInstallMode: "remote-download",
            remoteCdnBaseUrl: cdnServer.baseUrl,
          },
        ),
      ]);
      expect(
        cdnServer.getRequestCount(
          `/${ZCODE_VERSION}/manifest-linux-arm64.json`,
        ),
      ).toBe(3);
    } finally {
      await cdnServer.close();
    }
  });

  it("并发 GLM 部署应按各自 manifest SHA 快照隔离 release", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-remote-deploy-"));
    tempDirs.push(rootDir);

    const mockCdnDir = join(rootDir, "mock-cdn");
    const cdnRoot = join(rootDir, "cdn");
    const remoteCacheDir = join(rootDir, "remote-cache");
    await stageRemoteRuntimeRelease(mockCdnDir);
    const initialManifest = await stageRemoteComponentArtifacts(
      mockCdnDir,
      cdnRoot,
    );
    const initialGlm = initialManifest.components.find(
      (component) => component.id === "glm",
    );
    if (!initialGlm) {
      throw new Error("missing glm component in staged manifest");
    }
    const pinnedArtifactPath = initialGlm.artifactPath.replace(
      /\.tar\.gz$/u,
      "-pinned.tar.gz",
    );
    await cp(
      join(cdnRoot, initialGlm.artifactPath),
      join(cdnRoot, pinnedArtifactPath),
    );
    const pinnedInitialManifest: RemoteComponentManifest = {
      ...initialManifest,
      components: initialManifest.components.map((component) =>
        component.id === "glm"
          ? { ...component, artifactPath: pinnedArtifactPath }
          : component,
      ),
    };

    await writeFile(
      join(
        mockCdnDir,
        "releases",
        ZCODE_VERSION,
        "glm",
        "linux-arm64",
        "zcode.cjs",
      ),
      "new GLM bytes under the same semantic version",
      "utf8",
    );
    const updatedManifest = await stageRemoteComponentArtifacts(
      mockCdnDir,
      cdnRoot,
    );
    const updatedGlm = updatedManifest.components.find(
      (component) => component.id === "glm",
    );
    if (!updatedGlm) {
      throw new Error("missing updated glm component in staged manifest");
    }
    expect(updatedGlm.version).toBe(initialGlm.version);
    expect(updatedGlm.sha256).not.toBe(initialGlm.sha256);
    const cdnServer = await createStaticFileServer(cdnRoot);

    try {
      const [initialReleaseDir, updatedReleaseDir] = await Promise.all([
        ensureRemoteReleaseDirFromCdn(
          {
            remoteCdnBaseUrl: cdnServer.baseUrl,
            remoteCacheDir,
            version: ZCODE_VERSION,
            platformArch: "linux-arm64",
            componentIds: ["glm"],
            manifestRef: {
              manifest: pinnedInitialManifest,
              releaseBaseCandidatesForComponents: [
                `${cdnServer.baseUrl}/${ZCODE_VERSION}`,
              ],
            },
          },
          { log: () => {}, logWarn: () => {} },
        ),
        ensureRemoteReleaseDirFromCdn(
          {
            remoteCdnBaseUrl: cdnServer.baseUrl,
            remoteCacheDir,
            version: ZCODE_VERSION,
            platformArch: "linux-arm64",
            componentIds: ["glm"],
            manifestRef: {
              manifest: updatedManifest,
              releaseBaseCandidatesForComponents: [
                `${cdnServer.baseUrl}/${ZCODE_VERSION}`,
              ],
            },
          },
          { log: () => {}, logWarn: () => {} },
        ),
      ]);

      expect(initialReleaseDir).toContain(initialGlm.sha256);
      expect(updatedReleaseDir).toContain(updatedGlm.sha256);
      expect(initialReleaseDir).not.toBe(updatedReleaseDir);
      expect(
        cdnServer.getRequestCount(
          toComponentArtifactRequestPath(pinnedArtifactPath),
        ),
      ).toBe(1);
      expect(
        cdnServer.getRequestCount(
          toComponentArtifactRequestPath(updatedGlm.artifactPath),
        ),
      ).toBe(1);
    } finally {
      await cdnServer.close();
    }
  });

  it("同一 GLM SHA 的普通下载与强制刷新并发时应复用一次已校验下载", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-remote-deploy-"));
    tempDirs.push(rootDir);

    const mockCdnDir = join(rootDir, "mock-cdn");
    const cdnRoot = join(rootDir, "cdn");
    const remoteCacheDir = join(rootDir, "remote-cache");
    await stageRemoteRuntimeRelease(mockCdnDir);
    const manifest = await stageRemoteComponentArtifacts(mockCdnDir, cdnRoot);
    const glm = findManifestComponent(manifest, "glm");
    const requiredPluginPath = OFFICIAL_PLUGIN_REQUIRED_RELATIVE_PATHS[0];
    if (!requiredPluginPath) {
      throw new Error("missing required official plugin test path");
    }
    const artifactRequestPath = toComponentArtifactRequestPath(
      glm.artifactPath,
    );
    let releaseArtifactResponse: (() => void) | undefined;
    const artifactResponseGate = new Promise<void>((resolve) => {
      releaseArtifactResponse = resolve;
    });
    const cdnServer = await createStaticFileServer(cdnRoot, {
      responseGates: new Map([[artifactRequestPath, artifactResponseGate]]),
    });
    const releaseOptions = {
      remoteCdnBaseUrl: cdnServer.baseUrl,
      remoteCacheDir,
      version: ZCODE_VERSION,
      platformArch: "linux-arm64",
      componentIds: ["glm"],
      requiredReleasePaths: [
        "glm/linux-arm64/zcode.cjs",
        ...OFFICIAL_PLUGIN_REQUIRED_RELATIVE_PATHS.map(
          (relativePath) => `glm/linux-arm64/packages/${relativePath}`,
        ),
      ],
      manifestRef: {
        manifest,
        releaseBaseCandidatesForComponents: [
          `${cdnServer.baseUrl}/${ZCODE_VERSION}`,
        ],
      },
    };
    const loggers = { log: () => {}, logWarn: () => {} };

    try {
      const reuseReleasePromise = ensureRemoteReleaseDirFromCdn(
        releaseOptions,
        loggers,
      );
      await vi.waitFor(() => {
        expect(cdnServer.getRequestCount(artifactRequestPath)).toBe(1);
      });

      // Bugfix 验证：普通下载已持有同一 SHA component 锁时，force 应复用这次
      // 已校验下载；拆分锁会让两个任务并发替换同一目录并产生重复 CDN 请求。
      const forceReleasePromise = ensureRemoteReleaseDirFromCdn(
        { ...releaseOptions, forceRefresh: true },
        loggers,
      );
      releaseArtifactResponse?.();

      const [reuseReleaseDir, forceReleaseDir] = await Promise.all([
        reuseReleasePromise,
        forceReleasePromise,
      ]);

      expect(forceReleaseDir).toBe(reuseReleaseDir);
      expect(forceReleaseDir).toContain(glm.sha256);
      expect(cdnServer.getRequestCount(artifactRequestPath)).toBe(1);
      await expect(
        readFile(
          join(forceReleaseDir, "glm", "linux-arm64", "zcode.cjs"),
          "utf8",
        ),
      ).resolves.toBe("glm bundle");
      await expect(
        readFile(
          join(
            forceReleaseDir,
            "glm",
            "linux-arm64",
            "packages",
            requiredPluginPath,
          ),
          "utf8",
        ),
      ).resolves.toBe(`glm official plugin ${requiredPluginPath}`);
    } finally {
      releaseArtifactResponse?.();
      await cdnServer.close();
    }
  });

  it("生产态组件 cache 未命中时应从旧 release cache 迁移相同内容组件", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-remote-deploy-"));
    tempDirs.push(rootDir);

    const mockCdnDir = join(rootDir, "mock-cdn");
    const cdnRoot = join(rootDir, "cdn");
    const remoteCacheDir = join(rootDir, "remote-cache");
    const platformKey = "linux-arm64";
    await stageRemoteRuntimeRelease(mockCdnDir);

    const sourceReleaseDir = join(mockCdnDir, "releases", ZCODE_VERSION);
    const legacyReleaseDir = join(
      remoteCacheDir,
      "releases",
      "1.2.9",
      platformKey,
    );
    await cp(sourceReleaseDir, legacyReleaseDir, { recursive: true });
    await writeFile(
      join(legacyReleaseDir, ".remote-assets-ready"),
      "legacy-ready\n",
      "utf8",
    );

    const nodeRuntimeSourceDir = join(sourceReleaseDir, "node", platformKey);
    const nodeRuntimeContentHash =
      await computePathContentSha256(nodeRuntimeSourceDir);
    const nodeRuntimeSemanticVersion = "v24.10.0";
    const migratedNodeRuntimeVersion = `v24.10.0+${nodeRuntimeContentHash.slice(0, 12)}`;
    const missingNodeRuntimeArtifactPath = `components/${platformKey}/node-runtime/${migratedNodeRuntimeVersion}.tar.gz`;
    const manifest = await stageRemoteComponentArtifacts(mockCdnDir, cdnRoot, {
      platformKey,
      mutateManifest: (rawManifest) => ({
        ...rawManifest,
        components: rawManifest.components.map((component) =>
          component.id === "node-runtime"
            ? {
                ...component,
                version: migratedNodeRuntimeVersion,
                artifactPath: missingNodeRuntimeArtifactPath,
              }
            : component,
        ),
      }),
    });
    const nodeRuntime = manifest.components.find(
      (component) => component.id === "node-runtime",
    );
    if (!nodeRuntime) {
      throw new Error("missing node-runtime component in staged manifest");
    }
    const glm = manifest.components.find((component) => component.id === "glm");
    if (!glm) {
      throw new Error("missing glm component in staged manifest");
    }

    const cdnServer = await createStaticFileServer(cdnRoot);
    try {
      await expect(
        ensureRemoteReleaseDirFromCdn(
          {
            remoteCdnBaseUrl: cdnServer.baseUrl,
            remoteCacheDir,
            version: ZCODE_VERSION,
            platformArch: platformKey,
          },
          { log: () => {}, logWarn: () => {} },
        ),
      ).resolves.toBe(
        join(
          remoteCacheDir,
          "releases",
          ZCODE_VERSION,
          platformKey,
          "glm-content",
          glm.sha256,
        ),
      );

      expect(
        cdnServer.getRequestCount(
          toVersionedArtifactRequestPath(nodeRuntime.artifactPath),
        ),
      ).toBe(0);
      await expect(
        readFile(
          join(
            remoteCacheDir,
            "components",
            "node-runtime",
            platformKey,
            nodeRuntimeSemanticVersion,
            ".ready",
          ),
          "utf8",
        ),
      ).resolves.toBeTruthy();
    } finally {
      await cdnServer.close();
    }
  });

  it("生产态 GLM 不应按语义版本复用旧 hash 目录组件", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-remote-deploy-"));
    tempDirs.push(rootDir);

    const mockCdnDir = join(rootDir, "mock-cdn");
    const cdnRoot = join(rootDir, "cdn");
    const remoteCacheDir = join(rootDir, "remote-cache");
    const platformKey = "linux-arm64";
    await stageRemoteRuntimeRelease(mockCdnDir);

    const sourceReleaseDir = join(mockCdnDir, "releases", ZCODE_VERSION);
    const oldGlmComponentVersion = `${LEGACY_REMOTE_TEST_AGENT_RUNTIME.glm.version}-glm+legacyhash001`;
    const oldGlmComponentDir = join(
      remoteCacheDir,
      "components",
      "glm",
      platformKey,
      oldGlmComponentVersion,
    );
    await mkdir(oldGlmComponentDir, { recursive: true });
    await copySourcePathContentToDir(
      join(sourceReleaseDir, "glm", platformKey),
      oldGlmComponentDir,
    );
    await writeFile(
      join(oldGlmComponentDir, ".ready"),
      "old-component-ready\n",
      "utf8",
    );

    const semanticGlmComponentVersion = `${LEGACY_REMOTE_TEST_AGENT_RUNTIME.glm.version}-glm`;
    const manifest = await stageRemoteComponentArtifacts(mockCdnDir, cdnRoot, {
      platformKey,
      mutateManifest: (rawManifest) => ({
        ...rawManifest,
        components: rawManifest.components.map((component) =>
          component.id === "glm"
            ? {
                ...component,
                version: semanticGlmComponentVersion,
              }
            : component,
        ),
      }),
    });
    const glm = manifest.components.find((component) => component.id === "glm");
    if (!glm) {
      throw new Error("missing glm component in staged manifest");
    }

    const cdnServer = await createStaticFileServer(cdnRoot);
    try {
      await expect(
        ensureRemoteReleaseDirFromCdn(
          {
            remoteCdnBaseUrl: cdnServer.baseUrl,
            remoteCacheDir,
            version: ZCODE_VERSION,
            platformArch: platformKey,
            componentIds: ["glm"],
          },
          { log: () => {}, logWarn: () => {} },
        ),
      ).resolves.toBe(
        join(
          remoteCacheDir,
          "releases",
          ZCODE_VERSION,
          platformKey,
          "glm-content",
          glm.sha256,
        ),
      );

      expect(
        cdnServer.getRequestCount(
          toComponentArtifactRequestPath(glm.artifactPath),
        ),
      ).toBe(1);
      await expect(
        readFile(
          join(
            remoteCacheDir,
            "components",
            "glm",
            platformKey,
            glm.sha256,
            ".ready",
          ),
          "utf8",
        ),
      ).resolves.toBeTruthy();
    } finally {
      await cdnServer.close();
    }
  });

  it("生产态 GLM manifest 版本变化时仍应按制品 SHA 建新缓存", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-remote-deploy-"));
    tempDirs.push(rootDir);

    const mockCdnDir = join(rootDir, "mock-cdn");
    const cdnRoot = join(rootDir, "cdn");
    const remoteCacheDir = join(rootDir, "remote-cache");
    const platformKey = "linux-arm64";
    await stageRemoteRuntimeRelease(mockCdnDir);

    const sourceReleaseDir = join(mockCdnDir, "releases", ZCODE_VERSION);
    const semanticGlmComponentVersion = `${LEGACY_REMOTE_TEST_AGENT_RUNTIME.glm.version}-glm`;
    const oldGlmComponentVersion = `${semanticGlmComponentVersion}+aaaaaa000001`;
    const oldGlmComponentDir = join(
      remoteCacheDir,
      "components",
      "glm",
      platformKey,
      oldGlmComponentVersion,
    );
    await mkdir(oldGlmComponentDir, { recursive: true });
    await copySourcePathContentToDir(
      join(sourceReleaseDir, "glm", platformKey),
      oldGlmComponentDir,
    );
    await writeFile(
      join(oldGlmComponentDir, ".ready"),
      "old-component-ready\n",
      "utf8",
    );

    const newGlmComponentVersion = `${semanticGlmComponentVersion}+bbbbbb000001`;
    const manifest = await stageRemoteComponentArtifacts(mockCdnDir, cdnRoot, {
      platformKey,
      mutateManifest: (rawManifest) => ({
        ...rawManifest,
        components: rawManifest.components.map((component) =>
          component.id === "glm"
            ? {
                ...component,
                version: newGlmComponentVersion,
              }
            : component,
        ),
      }),
    });
    const glm = manifest.components.find((component) => component.id === "glm");
    if (!glm) {
      throw new Error("missing glm component in staged manifest");
    }

    const cdnServer = await createStaticFileServer(cdnRoot);
    try {
      await expect(
        ensureRemoteReleaseDirFromCdn(
          {
            remoteCdnBaseUrl: cdnServer.baseUrl,
            remoteCacheDir,
            version: ZCODE_VERSION,
            platformArch: platformKey,
            componentIds: ["glm"],
          },
          { log: () => {}, logWarn: () => {} },
        ),
      ).resolves.toBe(
        join(
          remoteCacheDir,
          "releases",
          ZCODE_VERSION,
          platformKey,
          "glm-content",
          glm.sha256,
        ),
      );

      expect(
        cdnServer.getRequestCount(
          toComponentArtifactRequestPath(glm.artifactPath),
        ),
      ).toBe(1);
      await expect(
        readFile(
          join(
            remoteCacheDir,
            "components",
            "glm",
            platformKey,
            glm.sha256,
            ".ready",
          ),
          "utf8",
        ),
      ).resolves.toBeTruthy();
    } finally {
      await cdnServer.close();
    }
  });

  it("生产态不同 remoteCacheDir 并发预热时不应共享同一把下载锁", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-remote-deploy-"));
    tempDirs.push(rootDir);

    const mockCdnDir = join(rootDir, "mock-cdn");
    const cdnRoot = join(rootDir, "cdn");
    const remoteCacheDirA = join(rootDir, "remote-cache-a");
    const remoteCacheDirB = join(rootDir, "remote-cache-b");
    await stageRemoteRuntimeRelease(mockCdnDir);
    const manifest = await stageRemoteComponentArtifacts(mockCdnDir, cdnRoot);
    const cdnServer = await createStaticFileServer(cdnRoot);
    const serverBundle = manifest.components.find(
      (component) => component.id === "server-bundle",
    );
    if (!serverBundle) {
      throw new Error("missing server-bundle component in staged manifest");
    }

    try {
      // Bugfix: 之前锁 key 没有带 remoteCacheDir，导致不同缓存目录会误共享同一 Promise。
      // 这里并发预热两个 cache，断言应各自返回独立目录并各自下载一次。
      const [releaseDirA, releaseDirB] = await Promise.all([
        ensureRemoteReleaseDirFromCdn(
          {
            remoteCdnBaseUrl: cdnServer.baseUrl,
            remoteCacheDir: remoteCacheDirA,
            version: ZCODE_VERSION,
            platformArch: "linux-arm64",
          },
          { log: () => {}, logWarn: () => {} },
        ),
        ensureRemoteReleaseDirFromCdn(
          {
            remoteCdnBaseUrl: cdnServer.baseUrl,
            remoteCacheDir: remoteCacheDirB,
            version: ZCODE_VERSION,
            platformArch: "linux-arm64",
          },
          { log: () => {}, logWarn: () => {} },
        ),
      ]);

      expect(releaseDirA).not.toBe(releaseDirB);
      expect(releaseDirA).toContain("remote-cache-a");
      expect(releaseDirB).toContain("remote-cache-b");
      expect(
        cdnServer.getRequestCount(
          `/${ZCODE_VERSION}/manifest-linux-arm64.json`,
        ),
      ).toBe(2);
      expect(
        cdnServer.getRequestCount(
          toVersionedArtifactRequestPath(serverBundle.artifactPath),
        ),
      ).toBe(0);
      expect(
        cdnServer.getRequestCount(
          toComponentArtifactRequestPath(serverBundle.artifactPath),
        ),
      ).toBe(2);
    } finally {
      await cdnServer.close();
    }
  });

  it("生产态 manifest mount 路径校验失败时应抛出错误", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-remote-deploy-"));
    tempDirs.push(rootDir);

    const mockCdnDir = join(rootDir, "mock-cdn");
    const cdnRoot = join(rootDir, "cdn");
    const remoteCacheDir = join(rootDir, "remote-cache");
    await stageRemoteRuntimeRelease(mockCdnDir);
    await stageRemoteComponentArtifacts(mockCdnDir, cdnRoot, {
      mutateManifest: (manifest) => ({
        ...manifest,
        components: manifest.components.map((component) =>
          component.id === "server-bundle"
            ? { ...component, mount: "../escape-release-root" }
            : component,
        ),
      }),
    });
    const cdnServer = await createStaticFileServer(cdnRoot);

    try {
      await expect(
        deployServer(
          new FakeRemoteBackend({
            "~/.zcode/server/agents/codex/.version": "0.0.0\n",
          }),
          { platform: "linux", arch: "arm64" },
          {
            force: false,
            remoteCdnBaseUrl: cdnServer.baseUrl,
            remoteCacheDir,
          },
        ),
      ).rejects.toThrow(/mount|白名单|路径|path|invalid|escape/iu);
      expect(
        cdnServer.getRequestCount(
          `/${ZCODE_VERSION}/remote-assets-linux-arm64.tar.gz`,
        ),
      ).toBe(0);
    } finally {
      await cdnServer.close();
    }
  });

  it("生产态下载 remote 资源时应输出百分比/体积/速度进度日志", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-remote-deploy-"));
    tempDirs.push(rootDir);

    const mockCdnDir = join(rootDir, "mock-cdn");
    const cdnRoot = join(rootDir, "cdn");
    const remoteCacheDir = join(rootDir, "remote-cache");
    await stageRemoteRuntimeRelease(mockCdnDir);
    await stageRemoteComponentArtifacts(mockCdnDir, cdnRoot);
    const cdnServer = await createStaticFileServer(cdnRoot);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await deployServer(
        new FakeRemoteBackend({
          "~/.zcode/server/agents/codex/.version": "0.0.0\n",
        }),
        { platform: "linux", arch: "arm64" },
        {
          force: false,
          remoteCdnBaseUrl: cdnServer.baseUrl,
          remoteCacheDir,
        },
      );

      const allLogLines = logSpy.mock.calls.map((args) =>
        args.map((arg) => String(arg)).join(" "),
      );
      const progressLine = allLogLines.find((line) =>
        line.includes("download progress:"),
      );
      expect(progressLine).toBeTruthy();
      expect(progressLine).toMatch(/\d+(?:\.\d+)?%/u);
      expect(progressLine).toMatch(/\d+(?:\.\d+)?\/\d+(?:\.\d+)?\s*MB/u);
      expect(progressLine).toMatch(/\d+(?:\.\d+)?\s*MB\/s/u);
    } finally {
      logSpy.mockRestore();
      await cdnServer.close();
    }
  });

  it("Windows 原生 remote 应显式报不支持", async () => {
    const backend = new FakeRemoteBackend();

    await expect(
      deployServer(
        backend,
        { platform: "win32", arch: "x64" },
        {
          force: false,
          mockCdnDir: "/tmp/unused",
        },
      ),
    ).rejects.toThrow(/暂不支持 Windows 原生远程主机/);
  });
});
