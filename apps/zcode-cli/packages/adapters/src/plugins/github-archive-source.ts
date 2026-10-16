import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  appendPluginSourceCleanupError,
  cleanupPluginSourceBestEffort,
  directoryExists,
  fileExists,
  resolveInside,
} from "./helpers.js";
import {
  PluginZipDownloadError,
  resolveHttpZipSource,
  type ResolvedZipPluginSourceRoot,
} from "./zip-source.js";

const GITHUB_HOSTS = new Set(["github.com", "www.github.com"]);
const GITHUB_REPOSITORY_SEGMENT = /^[A-Za-z0-9_.-]+$/u;

export interface PublicGitHubRepository {
  owner: string;
  repo: string;
}

export interface ResolveGitHubArchiveSourceInput {
  path?: string;
  pin?: string;
  signal?: AbortSignal;
  url: string;
}

export class GitHubArchiveRequiresGitError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`GitHub Archive requires system Git fallback: ${reason}`);
    this.name = "GitHubArchiveRequiresGitError";
    this.reason = reason;
  }
}

export function parsePublicGitHubRepositoryUrl(value: string): PublicGitHubRepository | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    !GITHUB_HOSTS.has(url.hostname.toLowerCase()) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    return null;
  }
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 2) return null;
  const owner = segments[0] ?? "";
  const repo = (segments[1] ?? "").replace(/\.git$/u, "");
  if (
    !owner ||
    !repo ||
    owner === "." ||
    owner === ".." ||
    repo === "." ||
    repo === ".." ||
    !GITHUB_REPOSITORY_SEGMENT.test(owner) ||
    !GITHUB_REPOSITORY_SEGMENT.test(repo)
  ) {
    return null;
  }
  return { owner, repo };
}

export function buildGitHubArchiveUrl(repository: PublicGitHubRepository, pin = "HEAD"): string {
  const normalizedPin = pin.trim() || "HEAD";
  return `https://api.github.com/repos/${repository.owner}/${repository.repo}/zipball/${encodeURIComponent(normalizedPin)}`;
}

export async function resolveGitHubArchiveSource(
  input: ResolveGitHubArchiveSourceInput,
): Promise<ResolvedZipPluginSourceRoot> {
  const repository = parsePublicGitHubRepositoryUrl(input.url);
  if (!repository) {
    throw new GitHubArchiveRequiresGitError(
      `source is not a public GitHub HTTPS repository: ${input.url}`,
    );
  }
  const resolved = await resolveHttpZipSource({
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "ZCode-Plugin-Installer",
    },
    requireSingleRoot: true,
    signal: input.signal,
    stripRoot: true,
    url: buildGitHubArchiveUrl(repository, input.pin),
  });
  try {
    let selectedPath = resolved.path;
    if (input.path) {
      const subdir = resolveInside(resolved.path, input.path);
      if (!subdir || !directoryExists(subdir)) {
        throw new Error(`Plugin source subdirectory does not exist: ${input.path}`);
      }
      selectedPath = subdir;
    }
    const gitReason = await detectRequiredGitSemantics(resolved.path, selectedPath);
    if (gitReason) throw new GitHubArchiveRequiresGitError(gitReason);
    return { cleanup: resolved.cleanup, path: selectedPath };
  } catch (error) {
    const cleanupError = await cleanupPluginSourceBestEffort(resolved.cleanup);
    throw appendPluginSourceCleanupError(error, cleanupError);
  }
}

export function shouldFallbackGitHubArchiveToGit(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    error instanceof GitHubArchiveRequiresGitError ||
    (error instanceof PluginZipDownloadError &&
      (error.status === 401 || error.status === 403 || error.status === 404)) ||
    /plugin zip entry symlinks are not supported|unsupported plugin zip entry type/iu.test(message)
  );
}

async function detectRequiredGitSemantics(
  repositoryRoot: string,
  selectedRoot: string,
): Promise<string | null> {
  // Archive 不会物化 submodule 或 Git LFS 对象；若仍把指针文件当插件安装，
  // 会得到表面成功但运行时缺文件的损坏缓存，因此这两类仓库必须回到完整 Git 语义。
  if (fileExists(join(repositoryRoot, ".gitmodules"))) {
    return "repository declares Git submodules";
  }
  if (await directoryDeclaresGitLfs(repositoryRoot, selectedRoot === repositoryRoot)) {
    return "repository declares Git LFS filters";
  }
  if (selectedRoot !== repositoryRoot) {
    // Git attributes 从仓库根到目标文件逐级继承。只检查仓库根和插件目录
    // 会漏掉 packages/.gitattributes -> packages/plugin/** 这类父目录 LFS 规则，
    // 进而把 Archive 内的 LFS pointer 当成真实插件资源写入缓存。
    if (await ancestorDirectoriesDeclareGitLfs(repositoryRoot, selectedRoot)) {
      return "selected plugin path inherits Git LFS filters";
    }
    if (await directoryDeclaresGitLfs(selectedRoot, true)) {
      return "selected plugin path declares Git LFS filters";
    }
  }
  return null;
}

async function ancestorDirectoriesDeclareGitLfs(
  repositoryRoot: string,
  selectedRoot: string,
): Promise<boolean> {
  const normalizedRepositoryRoot = resolve(repositoryRoot);
  let current = dirname(resolve(selectedRoot));
  while (current !== normalizedRepositoryRoot) {
    if (await directoryDeclaresGitLfs(current, false)) return true;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return false;
}

async function directoryDeclaresGitLfs(rootPath: string, recursive: boolean): Promise<boolean> {
  const attributesPath = join(rootPath, ".gitattributes");
  if (fileExists(attributesPath)) {
    const attributes = await readFile(attributesPath, "utf8");
    if (/(?:^|\s)filter=lfs(?:\s|$)/mu.test(attributes)) return true;
  }
  if (!recursive) return false;
  const entries = await readdir(rootPath, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (await directoryDeclaresGitLfs(join(rootPath, entry.name), true)) return true;
  }
  return false;
}
