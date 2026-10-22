import { ZCODE_VERSION } from "@zcode/shared";
import type { IRemoteBackend, RemoteEnvironment } from "@zcode/server/remote/backend.js";
import {
  REMOTE_BASE,
  type DeployLoggers,
  type RemoteAssetDeployOptions,
} from "@zcode/server/remote/deployShared.js";
import {
  readRemoteAssetComponentMeta,
  writeRemoteAssetComponentMeta,
} from "@zcode/server/remote/remoteAssetLiveIdentity.js";
import {
  fetchRemoteAssetManifestFromCdn,
  resolveRemoteAssetComponentCacheVersion,
  selectRemoteAssetManifestComponents,
  type RemoteAssetManifest,
} from "@zcode/server/remote/remoteAssetCache.js";
import {
  LocalUploadAssetInstaller,
  type RemoteAssetInstaller,
} from "@zcode/server/remote/remoteAssetInstaller.js";
import type { RemoteAssetNetworkPort } from "@zcode/server/remote/remoteAssetNetwork.js";

const REMOTE_NODE_PTY_PATH = `${REMOTE_BASE}/build/Release/pty.node`;
const REMOTE_NODE_PTY_SPAWN_HELPER_PATH = `${REMOTE_BASE}/build/Release/spawn-helper`;

export interface RemoteAssetVersionResolverOptions {
  mockCdnDir?: string;
  remoteCdnBaseUrl?: string;
  remoteCdnBaseUrls?: string[];
  remoteCacheDir?: string;
  manifestRequestTimeoutMs?: number;
  remoteAssetNetwork?: RemoteAssetNetworkPort;
}

interface DeployNodePtyPrebuildOptions extends RemoteAssetDeployOptions {
  platformArch: string;
  force?: boolean;
  onlyIfMissing: boolean;
  installer: RemoteAssetInstaller;
  expectedVersion?: string | null;
}

interface DeployNodeRuntimeOptions extends RemoteAssetDeployOptions {
  platformArch: string;
  force?: boolean;
  installer: RemoteAssetInstaller;
  expectedVersion?: string | null;
}

type DeployDecision = { shouldDeploy: false } | { shouldDeploy: true; reason: string };

export function createRemoteComponentVersionResolver(
  options: RemoteAssetVersionResolverOptions,
  env: RemoteEnvironment,
  loggers: DeployLoggers,
): (componentId: string) => Promise<string | null> {
  let componentManifestPromise: Promise<RemoteAssetManifest | null> | null = null;
  const getComponentManifest = (): Promise<RemoteAssetManifest | null> => {
    componentManifestPromise ??= resolveComponentManifest(options, env, loggers);
    return componentManifestPromise;
  };

  return async (componentId) => {
    const manifest = await getComponentManifest();
    if (!manifest) {
      return null;
    }
    const componentVersion = selectRemoteAssetManifestComponents(manifest, [componentId])[0]
      ?.version;
    return componentVersion ? resolveRemoteAssetComponentCacheVersion(componentVersion) : null;
  };
}

export async function deployNodeRuntime(
  backend: IRemoteBackend,
  options: DeployNodeRuntimeOptions,
  loggers: DeployLoggers,
): Promise<void> {
  const { platformArch, installer } = options;
  const remotePath = `${REMOTE_BASE}/node`;
  const expectedVersion = normalizeDeployExpectedVersion(options.expectedVersion);
  const decision = await shouldDeployVersionedComponent(backend, {
    componentId: "node-runtime",
    platformArch,
    remotePath,
    expectedVersion,
    force: options.force,
    fallbackDeployWhenVersionUnknown: true,
  });
  if (!decision.shouldDeploy) {
    loggers.log("node runtime already matches, skip");
    return;
  }

  logDeployRequired({
    loggers,
    installer,
    componentId: "node-runtime",
    reason: decision.reason,
  });
  await installer.installFile({
    componentId: "node-runtime",
    sourceRelativePath: `node/${platformArch}/node`,
    remotePath,
    executable: true,
  });
  await writeRemoteAssetComponentMeta(backend, {
    id: "node-runtime",
    version: expectedVersion ?? "unknown",
    platformArch,
  });
  loggers.log("node install done");
}

function normalizeDeployExpectedVersion(version: string | null | undefined): string | null {
  return version ? resolveRemoteAssetComponentCacheVersion(version) : null;
}

export async function deployNodePtyPrebuilds(
  backend: IRemoteBackend,
  env: RemoteEnvironment,
  options: DeployNodePtyPrebuildOptions,
  loggers: DeployLoggers,
): Promise<void> {
  const { platformArch, onlyIfMissing, installer } = options;
  const expectedVersion = normalizeDeployExpectedVersion(options.expectedVersion);
  const decision = await shouldDeployVersionedComponent(backend, {
    componentId: "node-pty",
    platformArch,
    remotePath: REMOTE_NODE_PTY_PATH,
    expectedVersion,
    force: options.force,
    fallbackDeployWhenVersionUnknown: !onlyIfMissing,
  });
  if (decision.shouldDeploy) {
    const sourceRelativePath = `node-pty/${platformArch}/pty.node`;
    if (
      installer instanceof LocalUploadAssetInstaller &&
      !(await installer.tryResolveLocalPath(["node-pty"], sourceRelativePath))
    ) {
      loggers.logWarn(`WARNING: no node-pty prebuild for ${platformArch}. Terminal will not work.`);
      loggers.logWarn(
        `Legacy component assets are no longer built; use the R3 Source Server archive flow.`,
      );
    } else {
      logDeployRequired({
        loggers,
        installer,
        componentId: "node-pty",
        reason: decision.reason,
      });
      loggers.log("installing node-pty prebuild...");
      await installer.installFile({
        componentId: "node-pty",
        sourceRelativePath,
        remotePath: REMOTE_NODE_PTY_PATH,
      });
      await writeRemoteAssetComponentMeta(backend, {
        id: "node-pty",
        version: expectedVersion ?? "unknown",
        platformArch,
      });
      loggers.log("node-pty install done");
    }
  } else {
    loggers.log("node-pty prebuild already exists, skip");
  }

  if (env.platform !== "darwin") {
    return;
  }

  const shouldUploadSpawnHelper =
    decision.shouldDeploy || !(await backend.exists(REMOTE_NODE_PTY_SPAWN_HELPER_PATH));
  if (shouldUploadSpawnHelper) {
    const sourceRelativePath = `node-pty/${platformArch}/spawn-helper`;
    if (
      installer instanceof LocalUploadAssetInstaller &&
      !(await installer.tryResolveLocalPath(["node-pty"], sourceRelativePath))
    ) {
      loggers.logWarn(
        `WARNING: no node-pty spawn-helper for ${platformArch}. Terminal may fail to start.`,
      );
      loggers.logWarn(
        `Legacy component assets are no longer built; use the R3 Source Server archive flow.`,
      );
      return;
    }

    loggers.log("installing node-pty spawn-helper...");
    if (!decision.shouldDeploy) {
      logDeployRequired({
        loggers,
        installer,
        componentId: "node-pty",
        reason: `remote file missing path=${REMOTE_NODE_PTY_SPAWN_HELPER_PATH}`,
      });
    }
    await installer.installFile({
      componentId: "node-pty",
      sourceRelativePath,
      remotePath: REMOTE_NODE_PTY_SPAWN_HELPER_PATH,
      executable: true,
    });
    loggers.log("node-pty spawn-helper install done");
  } else {
    loggers.log("node-pty spawn-helper already exists, skip");
  }
}

async function shouldDeployVersionedComponent(
  backend: IRemoteBackend,
  options: {
    componentId: string;
    platformArch: string;
    remotePath: string;
    expectedVersion?: string | null;
    force?: boolean;
    fallbackDeployWhenVersionUnknown: boolean;
  },
): Promise<DeployDecision> {
  if (options.force) {
    return { shouldDeploy: true, reason: "force deploy requested" };
  }

  if (!(await backend.exists(options.remotePath))) {
    return {
      shouldDeploy: true,
      reason: `remote file missing path=${options.remotePath}`,
    };
  }

  if (!options.expectedVersion) {
    return options.fallbackDeployWhenVersionUnknown
      ? {
          shouldDeploy: true,
          reason: "component version unavailable, using legacy full deploy",
        }
      : { shouldDeploy: false };
  }

  const remoteMeta = await readRemoteAssetComponentMeta(backend, options.componentId);
  if (!remoteMeta) {
    return {
      shouldDeploy: true,
      reason: `remote component meta missing expected=${options.expectedVersion}`,
    };
  }
  if (remoteMeta.id !== options.componentId) {
    return {
      shouldDeploy: true,
      reason: `remote component id mismatch remote=${remoteMeta.id} expected=${options.componentId}`,
    };
  }
  if (remoteMeta.platformArch !== options.platformArch) {
    return {
      shouldDeploy: true,
      reason: `remote platform mismatch remote=${remoteMeta.platformArch} expected=${options.platformArch}`,
    };
  }
  if (
    normalizeDeployExpectedVersion(remoteMeta.version) !==
    normalizeDeployExpectedVersion(options.expectedVersion)
  ) {
    return {
      shouldDeploy: true,
      reason: `remote version mismatch remote=${remoteMeta.version} expected=${options.expectedVersion}`,
    };
  }

  return { shouldDeploy: false };
}

export function logDeployRequired(options: {
  loggers: Pick<DeployLoggers, "logWarn">;
  installer: RemoteAssetInstaller;
  componentId: string;
  reason: string;
}): void {
  const action =
    options.installer.mode === "remote-download" ? "download required" : "upload required";
  options.loggers.logWarn(
    `[remote-assets] ${action}: component=${options.componentId} reason=${options.reason}`,
  );
}

async function resolveComponentManifest(
  options: RemoteAssetVersionResolverOptions,
  env: RemoteEnvironment,
  loggers: DeployLoggers,
): Promise<RemoteAssetManifest | null> {
  if (options.mockCdnDir) {
    return null;
  }

  try {
    return await fetchRemoteAssetManifestFromCdn(
      {
        remoteCdnBaseUrl: options.remoteCdnBaseUrl,
        remoteCdnBaseUrls: options.remoteCdnBaseUrls,
        remoteCacheDir: options.remoteCacheDir,
        version: ZCODE_VERSION,
        platformArch: `${env.platform}-${env.arch}`,
        manifestRequestTimeoutMs: options.manifestRequestTimeoutMs,
        remoteAssetNetwork: options.remoteAssetNetwork,
      },
      loggers,
    );
  } catch (error) {
    loggers.logWarn(`[remote-assets] component manifest request failed: ${String(error)}`);
    // version resolver 与 pinned identity 共享同一 manifest deadline。
    // 网络/响应体失败时不得降级成 null，否则持锁路径会再发起默认 10s 请求。
    throw error;
  }
}
