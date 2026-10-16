import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReleaseManifest } from "../contracts.js";
import { ComponentCache } from "./componentCache.js";
import { currentServerTarget, serverRuntimeManifestSchema } from "./manifest.js";
import type { ServerLayout } from "./paths.js";
import { fetchReleaseCatalog, fetchReleaseJson, ReleaseDownloader } from "./releaseDownload.js";
import { ReleaseInstaller } from "./releaseInstaller.js";
import { ReleaseManager } from "./releaseManager.js";

export type UpdatePreparation =
  | { status: "up-to-date"; version: string }
  | { status: "prepared"; version: string; discard: () => Promise<void> }
  | { status: "prepared-offline"; version: string };

async function pathExists(path: string): Promise<boolean> {
  return await access(path).then(() => true, () => false);
}

function sameRelease(left: ReleaseManifest | null, right: ReleaseManifest): boolean {
  return left?.version === right.version && left.releaseDir === right.releaseDir;
}

function isStalePending(pending: ReleaseManifest, current: ReleaseManifest): boolean {
  if (sameRelease(pending, current)) return true;
  if (pending.archiveSha256 && current.archiveSha256 && pending.archiveSha256 === current.archiveSha256) return true;
  // 只清理不可能比 current 更新的遗留候选；未来版本的 pending 仍保留，供用户在
  // catalog 暂时回滚或离线时显式应用。
  return pending.version.localeCompare(current.version, undefined, { numeric: true }) <= 0;
}

function createPreparedReleaseDiscarder(input: {
  layout: ServerLayout;
  current: ReleaseManifest | null;
  previousPending: ReleaseManifest | null;
  prepared: ReleaseManifest;
  releaseDirExisted: boolean;
}): () => Promise<void> {
  let discarded = false;
  return async () => {
    if (discarded) return;
    discarded = true;
    const releaseManager = new ReleaseManager(input.layout);
    const pending = await releaseManager.readPending();
    // 准备期间任务可能启动，apply-update 随后拒绝切换；若直接返回错误，
    // 本次 CLI 生成的 pending/release 会遗留并被下一次更新误认为可直接应用。只回滚仍
    // 指向本次 candidate 的 pending，避免覆盖并发更新已经写入的更新意图。
    if (!sameRelease(pending, input.prepared)) return;
    if (input.previousPending) await releaseManager.writePending(input.previousPending);
    else await releaseManager.removePending();
    if (!input.releaseDirExisted && input.current?.releaseDir !== input.prepared.releaseDir) {
      await rm(input.prepared.releaseDir, { recursive: true, force: true });
    }
  };
}

export async function prepareOnlineUpdate(layout: ServerLayout): Promise<UpdatePreparation> {
  const catalogUrl = process.env.ZCODE_SERVER_RELEASE_MANIFEST_URL?.trim();
  if (!catalogUrl) {
    const pending = await new ReleaseManager(layout).readPending();
    if (!pending) {
      throw new Error(
        "ZCode Server release source is not configured and no offline pending release is available",
      );
    }
    return { status: "prepared-offline", version: pending.version };
  }
  const target = currentServerTarget();
  const catalog = await fetchReleaseCatalog(catalogUrl);
  const candidates = catalog.releases.filter((release) => release.target === target);
  const release = candidates
    .sort((left, right) => left.version.localeCompare(right.version, undefined, { numeric: true }))
    .at(-1);
  if (!release) throw new Error(`No release for target ${target} in catalog`);
  const releaseManager = new ReleaseManager(layout);
  const current = await releaseManager.readCurrent();
  if (current?.target === target && current.archiveSha256 === release.archiveSha256) {
    const pending = await releaseManager.readPending();
    if (pending && isStalePending(pending, current)) {
      // 在线检查确认 current 已是 catalog 最新版本时，不能直接返回
      // up-to-date，却留下旧 pending.json；下一次无网络更新会误应用该指针并降级。
      await releaseManager.removePending();
    }
    return { status: "up-to-date", version: current.version };
  }
  if (release.manifestUrl && release.components && current?.components) {
    const assembled = await prepareComponentUpdate({
      layout,
      target,
      release,
      manifestUrl: release.manifestUrl,
      current,
    });
    if (assembled) {
      return {
        status: "prepared",
        version: release.version,
        discard: createPreparedReleaseDiscarder(assembled),
      };
    }
  }
  const temporaryDir = await mkdtemp(join(tmpdir(), "zcode-server-update-"));
  const archiveName = release.archiveUrl.toLowerCase().endsWith(".zip")
    ? "release.zip"
    : "release.tar.gz";
  const archivePath = join(temporaryDir, archiveName);
  try {
    await new ReleaseDownloader().download({
      url: release.archiveUrl,
      destination: archivePath,
      sha256: release.archiveSha256,
      expectedSizeBytes: release.archiveSizeBytes,
    });
    const releaseVersion = release.appVersion ?? release.version;
    const releaseDir = join(layout.releasesDir, `${releaseVersion}-${target}-${release.archiveSha256.toLowerCase().slice(0, 12)}`);
    const releaseDirExisted = await pathExists(releaseDir);
    const previousPending = await new ReleaseManager(layout).readPending();
    const prepared = await new ReleaseInstaller(layout).installArchive({
      archivePath,
      target,
      version: releaseVersion,
      archiveSha256: release.archiveSha256,
    });
    return {
      status: "prepared",
      version: release.version,
      discard: createPreparedReleaseDiscarder({
        layout,
        current,
        previousPending,
        prepared,
        releaseDirExisted,
      }),
    };
  } finally {
    await rm(temporaryDir, { recursive: true, force: true });
  }
}

async function prepareComponentUpdate(input: {
  layout: ServerLayout;
  target: ReturnType<typeof currentServerTarget>;
  release: NonNullable<Awaited<ReturnType<typeof fetchReleaseCatalog>>["releases"][number]>;
  manifestUrl: string;
  current: NonNullable<Awaited<ReturnType<ReleaseManager["readCurrent"]>>>;
}): Promise<{
  layout: ServerLayout;
  current: ReleaseManifest;
  previousPending: ReleaseManifest | null;
  prepared: ReleaseManifest;
  releaseDirExisted: boolean;
} | null> {
  // 组件增量更新的 manifest 请求原来没有应用层 AbortSignal，服务端无响应时
  // 会等到 undici 默认边界（约数分钟）。复用带超时的 JSON 下载器，和 catalog 行为一致。
  const remoteManifest = await fetchReleaseJson(
    input.manifestUrl,
    serverRuntimeManifestSchema,
    10_000,
    "Runtime manifest",
  );
  if (remoteManifest.target !== input.target) {
    throw new Error(`Runtime manifest target mismatch: ${remoteManifest.target}`);
  }
  const currentComponents = new Map(
    (input.current.components ?? []).map((component) => [component.id, component]),
  );
  if (!remoteManifest.components) return null;
  const changed: Array<{ componentId: string; sha256: string; archivePath: string }> = [];
  const temporaryDir = await mkdtemp(join(tmpdir(), "zcode-server-components-"));
  const cache = new ComponentCache(input.layout);
  try {
    for (const component of input.release.components ?? []) {
      const currentComponent = currentComponents.get(component.id);
      const remoteComponent = remoteManifest.components.find(
        (candidate) => candidate.id === component.id,
      );
      const pathsUnchanged = currentComponent && remoteComponent
        ? currentComponent.paths.length === remoteComponent.paths.length &&
          currentComponent.paths.every((path, index) => path === remoteComponent.paths[index])
        : false;
      if (currentComponent?.sha256 === component.sha256 && pathsUnchanged) continue;
      if (!component.archiveUrl || !component.archiveSha256) return null;
      const extension = component.archiveUrl.toLowerCase().endsWith(".zip") ? "zip" : "tar.gz";
      const cachedArchive = await cache.findArchive({
        target: input.target,
        componentId: component.id,
        sha256: component.sha256,
        extension,
      });
      const cached = cachedArchive ?? await downloadComponent({
        cache,
        component,
        extension,
        target: input.target,
        temporaryDir,
      });
      changed.push({ componentId: component.id, sha256: component.sha256, archivePath: cached });
    }
    const releaseId = `${input.release.version}-${input.target}-${input.release.archiveSha256.slice(0, 12)}`;
    const releaseDir = join(input.layout.releasesDir, releaseId);
    const releaseDirExisted = await pathExists(releaseDir);
    const releaseManager = new ReleaseManager(input.layout);
    const previousPending = await releaseManager.readPending();
    await cache.assemble({
      target: input.target,
      archiveSha256: input.release.archiveSha256,
      baseReleaseDir: input.current.releaseDir,
      releaseDir,
      runtimeManifest: remoteManifest,
      baseComponents: input.current.components,
      changed,
    });
    const prepared = {
      version: input.release.version,
      releaseDir,
      releaseId,
      appVersion: input.release.appVersion ?? input.release.version,
      target: input.target,
      nodeVersion: remoteManifest.nodeVersion,
      archiveSha256: input.release.archiveSha256,
      components: remoteManifest.components,
    } satisfies ReleaseManifest;
    await releaseManager.writePending(prepared);
    return {
      layout: input.layout,
      current: input.current,
      previousPending,
      prepared,
      releaseDirExisted,
    };
  } finally {
    await rm(temporaryDir, { recursive: true, force: true });
  }
}

async function downloadComponent(input: {
  cache: ComponentCache;
  component: NonNullable<Awaited<ReturnType<typeof fetchReleaseCatalog>>["releases"][number]["components"]>[number];
  extension: string;
  target: ReturnType<typeof currentServerTarget>;
  temporaryDir: string;
}): Promise<string> {
  if (!input.component.archiveUrl || !input.component.archiveSha256) {
    throw new Error(`Component ${input.component.id} has no archive source`);
  }
  const archivePath = join(input.temporaryDir, `${input.component.id}.${input.extension}`);
  await new ReleaseDownloader().download({
    url: input.component.archiveUrl,
    destination: archivePath,
    sha256: input.component.archiveSha256,
  });
  return await input.cache.putArchive({
    target: input.target,
    componentId: input.component.id,
    sha256: input.component.sha256,
    archivePath,
    archiveSha256: input.component.archiveSha256,
  });
}
