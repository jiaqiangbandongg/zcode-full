import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  readFile,
  readdir,
  realpath,
  stat,
  mkdir,
  open,
  rename,
  rm,
  rmdir,
  type FileHandle,
} from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  MAX_FILE_BYTES,
  OfficeError,
  extensionList,
  kindOf,
  type DocKind,
} from "#office/contract.ts";
import { TITLE } from "#office/wording.ts";

function inside(root: string, target: string) {
  const rel = relative(root, target);
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}

const toPosix = (path: string) => path.split(sep).join("/");

export interface LoadedFile {
  /** Workspace-relative path with forward slashes. */
  path: string;
  kind: DocKind;
  bytes: Uint8Array;
  revision: string;
  mtimeMs: number;
}

export interface WorkspaceFiles {
  /** Normalise a user or model path to a workspace-relative one; throws outside the workspace. */
  resolve(input: string): Promise<{ path: string; absolute: string; kind: DocKind }>;
  load(input: string): Promise<LoadedFile>;
  /** Cheap change check: size + mtime, without reading the file. */
  fingerprint(input: string): Promise<string>;
  list(options?: {
    limit?: number;
  }): Promise<{ path: string; kind: DocKind; bytes: number; mtimeMs: number }[]>;
}

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "dist",
  "build",
  ".venv",
  "__pycache__",
]);

export function createWorkspaceFiles(workspace: string): WorkspaceFiles {
  let rootPromise: Promise<string> | undefined;
  const root = () => (rootPromise ??= realpath(workspace));

  async function resolvePath(input: string) {
    if (typeof input !== "string" || !input.trim() || input.includes("\0"))
      throw new OfficeError("invalid_path", "A document path is required.");
    const base = await root();
    const target = resolve(base, input.trim());
    if (!inside(base, target) && target !== base)
      throw new OfficeError("path_outside_workspace", `Path is outside this workspace: ${input}`);
    const kind = kindOf(target);
    if (!kind)
      throw new OfficeError(
        "unsupported_type",
        `Unsupported file type: ${input}. ${TITLE} opens ${extensionList()} files.`,
      );
    let actual: string;
    try {
      actual = await realpath(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw new OfficeError("not_found", `File not found: ${toPosix(relative(base, target))}`);
      throw error;
    }
    if (!inside(base, actual))
      throw new OfficeError("path_outside_workspace", "The path links outside this workspace.");
    return { path: toPosix(relative(base, target)), absolute: actual, kind };
  }

  async function checkedStat(absolute: string, path: string) {
    const info = await stat(absolute);
    if (!info.isFile()) throw new OfficeError("not_found", `Not a file: ${path}`);
    if (info.size > MAX_FILE_BYTES)
      throw new OfficeError(
        "file_too_large",
        `${path} is ${(info.size / 1024 / 1024).toFixed(1)} MiB; the limit is ${MAX_FILE_BYTES / 1024 / 1024} MiB.`,
      );
    return info;
  }

  return {
    resolve: resolvePath,
    async load(input) {
      const { path, absolute, kind } = await resolvePath(input);
      const info = await checkedStat(absolute, path);
      const bytes = new Uint8Array(await readFile(absolute));
      const revision = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
      return { path, kind, bytes, revision, mtimeMs: info.mtimeMs };
    },
    async fingerprint(input) {
      const { path, absolute } = await resolvePath(input);
      const info = await checkedStat(absolute, path);
      return `${info.size}:${info.mtimeMs}`;
    },
    async list({ limit = 500 } = {}) {
      const base = await root();
      const found: { path: string; kind: DocKind; bytes: number; mtimeMs: number }[] = [];
      const queue: { dir: string; depth: number }[] = [{ dir: base, depth: 0 }];
      let visited = 0;
      // Breadth-first so shallow documents win when the workspace is large.
      while (queue.length && found.length < limit && visited < 5000) {
        const { dir, depth } = queue.shift()!;
        visited++;
        let entries;
        try {
          entries = await readdir(dir, { withFileTypes: true });
        } catch {
          continue;
        }
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
          if (entry.name.startsWith(".") || entry.name.startsWith("~$")) continue;
          const full = join(dir, entry.name);
          if (entry.isDirectory()) {
            if (depth < 8 && !SKIP_DIRS.has(entry.name))
              queue.push({ dir: full, depth: depth + 1 });
          } else if (entry.isFile()) {
            const kind = kindOf(entry.name);
            if (!kind) continue;
            const info = await lstat(full).catch(() => null);
            if (!info) continue;
            found.push({
              path: toPosix(relative(base, full)),
              kind,
              bytes: info.size,
              mtimeMs: info.mtimeMs,
            });
            if (found.length >= limit) break;
          }
        }
      }
      return found;
    },
  };
}

// 系统选择器只提供用户选中的文件字节；导入副本后复用工作区读取与对话引用，绝不放开任意路径读取。
const IMPORT_IDLE_MS = 10 * 60 * 1000;
const MAX_IMPORTS = 4;

export function createDocumentImporter(
  workspace: string,
  options: { now?: () => number; onCleanupError?: (error: unknown) => void } = {},
) {
  const now = options.now ?? Date.now;
  const uploads = new Map<
    string,
    {
      directory: string;
      name: string;
      size: number;
      offset: number;
      handle: FileHandle;
      touched: number;
    }
  >();
  let queue: Promise<unknown> = Promise.resolve();
  let closed = false;
  let rootPromise: Promise<string> | undefined;
  const root = () => (rootPromise ??= realpath(workspace));
  // 准入和 IO 共用串行队列，避免 await 之间突破槽位上限，也让 cancel 等待写入结束。
  const run = <T>(operation: () => Promise<T>): Promise<T> => {
    const task = queue.then(operation);
    queue = task.catch(() => undefined);
    return task;
  };
  async function parent(create = true) {
    const base = await root();
    const directory = join(base, ".zcode", "document-imports");
    if (create) await mkdir(directory, { recursive: true });
    else if (!(await lstat(directory).catch(() => null))) return null;
    if (!inside(base, await realpath(directory)))
      throw new OfficeError("invalid_path", "Import directory must remain inside the workspace.");
    return directory;
  }
  async function discard(id: string) {
    const upload = uploads.get(id);
    if (!upload) return;
    uploads.delete(id);
    await upload.handle.close().catch((error) => options.onCleanupError?.(error));
    await rm(upload.directory, { recursive: true, force: true }).catch((error) =>
      options.onCleanupError?.(error),
    );
  }
  async function sweep() {
    for (const [id, upload] of uploads)
      if (now() - upload.touched >= IMPORT_IDLE_MS) await discard(id);
    const directory = await parent(false);
    if (!directory) return;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = join(directory, entry.name);
      if ([...uploads.values()].some((upload) => upload.directory === candidate)) continue;
      const partial = join(candidate, ".partial");
      const info = await lstat(partial).catch(() => null);
      // 不能清空所有 UUID 目录：成品和其他会话近期写入的文件必须保留。
      if (!info?.isFile() || now() - info.mtimeMs < IMPORT_IDLE_MS) continue;
      await rm(partial, { force: true }).catch((error) => options.onCleanupError?.(error));
      // 只删除空目录，不递归删除潜在成品。
      await rmdir(candidate).catch((error) => options.onCleanupError?.(error));
    }
  }
  return {
    // 只读工作区仍可预览；启动清扫失败只记录，不能阻断插件连接。
    initialize: () => run(() => sweep().catch((error) => options.onCleanupError?.(error))),
    begin: (name: string, size: number) =>
      run(async () => {
        if (closed) throw new OfficeError("invalid_token", "Importer is closed.");
        if (basename(name) !== name || name.includes("\\") || !kindOf(name))
          throw new OfficeError("unsupported_type", "Unsupported file name or type.");
        if (!Number.isInteger(size) || size < 1 || size > MAX_FILE_BYTES)
          throw new OfficeError("file_too_large", "File size is outside the supported range.");
        await sweep();
        if (uploads.size >= MAX_IMPORTS)
          throw new OfficeError("invalid_token", "Too many pending imports.");
        const id = randomUUID();
        const directory = join((await parent())!, id);
        await mkdir(directory);
        try {
          const handle = await open(join(directory, ".partial"), "wx");
          uploads.set(id, { directory, name, size, offset: 0, handle, touched: now() });
          return id;
        } catch (error) {
          await rm(directory, { recursive: true, force: true }).catch((cleanupError) =>
            options.onCleanupError?.(cleanupError),
          );
          throw error;
        }
      }),
    chunk: (id: string, offset: number, bytes: Uint8Array) =>
      run(async () => {
        const upload = uploads.get(id);
        if (!upload || offset !== upload.offset || offset + bytes.length > upload.size)
          throw new OfficeError("invalid_token", "Invalid import offset or token.");
        let written = 0;
        while (written < bytes.length) {
          const result = await upload.handle.write(
            bytes,
            written,
            bytes.length - written,
            offset + written,
          );
          if (!result.bytesWritten)
            throw new OfficeError("corrupt_file", "File import could not be written.");
          written += result.bytesWritten;
        }
        upload.offset += written;
        upload.touched = now();
      }),
    finish: (id: string) =>
      run(async () => {
        const upload = uploads.get(id);
        if (!upload || upload.offset !== upload.size)
          throw new OfficeError("invalid_token", "File import is incomplete.");
        await upload.handle.close();
        const target = join(upload.directory, upload.name);
        await rename(join(upload.directory, ".partial"), target);
        uploads.delete(id);
        // macOS 的 /var 可能链接到 /private/var，计算相对路径时必须使用同一真实根目录。
        return toPosix(relative(await root(), target));
      }),
    cancel: (id: string) => run(() => discard(id)),
    close: () =>
      run(async () => {
        closed = true;
        for (const id of uploads.keys()) await discard(id);
      }),
  };
}
