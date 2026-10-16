import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import * as yauzl from "yauzl";

export interface ContentBundle {
  format: "zip";
  url: string;
  entry: string;
  sha256: string;
  sizeBytes?: number;
}

const ZIP_LIMIT = 8 * 1024 * 1024;
const EXPANDED_LIMIT = 32 * 1024 * 1024;
const CACHE_LIMIT = 128 * 1024 * 1024;
const MANIFEST = ".bundle.json";
type Manifest = { files: Record<string, { sha256: string; size: number }>; size: number };
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export function validateContentBundlePath(path: string): string {
  if (
    !path ||
    path.length > 240 ||
    path === MANIFEST ||
    /[\\:]/u.test(path) ||
    [...path].some((char) => char.charCodeAt(0) < 32)
  )
    throw new Error("bundle_path");
  for (const part of path.split("/")) {
    if (
      !part ||
      part === "." ||
      part === ".." ||
      /[. ]$/u.test(part) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part)
    )
      throw new Error("bundle_path");
  }
  return path;
}

async function extract(bytes: Buffer, directory: string): Promise<Manifest> {
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => {
    yauzl.fromBuffer(
      bytes,
      { lazyEntries: true, validateEntrySizes: true, strictFileNames: true },
      (error, value) => (error ? reject(error) : resolve(value!)),
    );
  });
  const manifest: Manifest = { files: Object.create(null), size: 0 };
  const names = new Set<string>();
  let count = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      zip.on("error", reject);
      zip.on("end", resolve);
      zip.on("entry", (entry: yauzl.Entry) => {
        void (async () => {
          if (++count > 128 || entry.generalPurposeBitFlag & 1)
            throw new Error("bundle_entry_limit");
          const isDirectory = entry.fileName.endsWith("/");
          const name = validateContentBundlePath(
            isDirectory ? entry.fileName.slice(0, -1) : entry.fileName,
          );
          const canonical = name.toLowerCase();
          if (names.has(canonical) || canonical === MANIFEST)
            throw new Error("bundle_duplicate_path");
          names.add(canonical);
          const fileType = (entry.externalFileAttributes >>> 16) & 0o170000;
          if (fileType && fileType !== (isDirectory ? 0o040000 : 0o100000))
            throw new Error("bundle_file_type");
          if (
            entry.uncompressedSize > ZIP_LIMIT ||
            manifest.size + entry.uncompressedSize > EXPANDED_LIMIT
          )
            throw new Error("bundle_expanded_size");
          if (isDirectory) {
            await mkdir(join(directory, name), { recursive: true });
          } else {
            const stream = await new Promise<NodeJS.ReadableStream>((res, rej) =>
              zip.openReadStream(entry, (error, value) => (error ? rej(error) : res(value!))),
            );
            const chunks: Buffer[] = [];
            let size = 0;
            for await (const chunk of stream) {
              const buffer = Buffer.from(chunk);
              size += buffer.length;
              if (size > ZIP_LIMIT || manifest.size + size > EXPANDED_LIMIT)
                throw new Error("bundle_expanded_size");
              chunks.push(buffer);
            }
            const content = Buffer.concat(chunks);
            const parent = name.includes("/") ? name.slice(0, name.lastIndexOf("/")) : "";
            await mkdir(join(directory, parent), { recursive: true });
            await writeFile(join(directory, name), content, { flag: "wx", mode: 0o600 });
            manifest.files[name] = { sha256: hash(content), size };
            manifest.size += size;
          }
          zip.readEntry();
        })().catch(reject);
      });
      zip.readEntry();
    });
    return manifest;
  } finally {
    zip.close();
  }
}

/** 仅供宿主装配：可信源和缓存根不从云端 payload 派生；cacheRoot 必须由单个宿主独占。 */
export function createContentBundleCache(options: {
  cacheRoot: string;
  isTrustedUrl: (url: URL) => boolean;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
}) {
  const leases = new Map<string, { digest: string; manifest: Manifest }>();
  let pending: Promise<unknown> = Promise.resolve();
  function exclusive<T>(run: () => Promise<T>): Promise<T> {
    const result = pending.then(run);
    pending = result.catch(() => {});
    return result;
  }
  function trustedUrl(value: string): URL {
    const url = new URL(value);
    if (
      !/^https?:$/u.test(url.protocol) ||
      url.username ||
      url.password ||
      !options.isTrustedUrl(url)
    )
      throw new Error("bundle_source");
    return url;
  }
  async function download(bundle: ContentBundle): Promise<Buffer> {
    let url = trustedUrl(bundle.url);
    const timeout = AbortSignal.timeout(30_000);
    const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
    for (let redirects = 0; redirects <= 3; redirects++) {
      const response = await (options.fetch ?? globalThis.fetch)(url, {
        redirect: "manual",
        signal,
        credentials: "omit",
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get("location");
        if (!location) throw new Error("bundle_redirect");
        url = trustedUrl(new URL(location, url).href);
        continue;
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new Error("bundle_download");
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > ZIP_LIMIT || (bundle.sizeBytes !== undefined && size > bundle.sizeBytes))
          throw new Error("bundle_download_size");
        chunks.push(Buffer.from(chunk));
      }
      if (bundle.sizeBytes !== undefined && size !== bundle.sizeBytes)
        throw new Error("bundle_download_size");
      const bytes = Buffer.concat(chunks);
      if (hash(bytes) !== bundle.sha256) throw new Error("bundle_integrity");
      return bytes;
    }
    throw new Error("bundle_redirect_limit");
  }
  async function checkedRead(
    directory: string,
    name: string,
    info: { sha256: string; size: number },
  ): Promise<Buffer> {
    validateContentBundlePath(name);
    let current = directory;
    if (!(await lstat(current)).isDirectory() || (await lstat(current)).isSymbolicLink())
      throw new Error("bundle_cache_type");
    for (const part of name.split("/")) {
      current = join(current, part);
      if ((await lstat(current)).isSymbolicLink()) throw new Error("bundle_cache_symlink");
    }
    const stat = await lstat(current);
    if (!stat.isFile() || stat.size !== info.size || stat.size > ZIP_LIMIT)
      throw new Error("bundle_cache_size");
    const content = await readFile(current);
    if (hash(content) !== info.sha256) throw new Error("bundle_cache_integrity");
    return content;
  }
  async function cached(digest: string): Promise<Manifest | undefined> {
    const directory = join(options.cacheRoot, digest);
    try {
      const stat = await lstat(join(directory, MANIFEST));
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) return undefined;
      const manifest: Manifest = JSON.parse(await readFile(join(directory, MANIFEST), "utf8"));
      if (
        !manifest.files ||
        !Number.isSafeInteger(manifest.size) ||
        manifest.size < 0 ||
        manifest.size > EXPANDED_LIMIT
      )
        return undefined;
      const entries = Object.entries(manifest.files);
      if (entries.length > 128) return undefined;
      let size = 0;
      for (const [name, info] of entries) {
        await checkedRead(directory, name, info);
        size += info.size;
      }
      return size === manifest.size ? manifest : undefined;
    } catch {
      return undefined;
    }
  }
  async function evict(clear: boolean) {
    const names = await readdir(options.cacheRoot).catch(() => []);
    const entries = await Promise.all(
      names
        .filter((name) => /^[a-f0-9]{64}$/u.test(name))
        .map(async (name) => {
          const directory = join(options.cacheRoot, name);
          const stat = await lstat(directory);
          const manifest = await cached(name);
          return { name, directory, time: stat.mtimeMs, size: manifest?.size ?? EXPANDED_LIMIT };
        }),
    );
    let total = entries.reduce((sum, entry) => sum + entry.size, 0);
    for (const entry of entries.sort((a, b) => a.time - b.time)) {
      if (!clear && total <= CACHE_LIMIT) break;
      if ([...leases.values()].some((lease) => lease.digest === entry.name)) continue;
      await rm(entry.directory, { recursive: true, force: true });
      total -= entry.size;
    }
  }
  return {
    acquire(bundle: ContentBundle) {
      return exclusive(async () => {
        if (
          bundle.format !== "zip" ||
          !/^[a-f0-9]{64}$/u.test(bundle.sha256) ||
          (bundle.sizeBytes !== undefined &&
            (!Number.isSafeInteger(bundle.sizeBytes) ||
              bundle.sizeBytes <= 0 ||
              bundle.sizeBytes > ZIP_LIMIT))
        )
          throw new Error("bundle_contract");
        validateContentBundlePath(bundle.entry);
        if (!bundle.entry.endsWith(".html")) throw new Error("bundle_entry");
        trustedUrl(bundle.url);
        const stagingRoot = join(options.cacheRoot, "staging");
        await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
        let manifest = await cached(bundle.sha256);
        const cacheHit = Boolean(manifest);
        if (!manifest) {
          if ([...leases.values()].some((lease) => lease.digest === bundle.sha256))
            throw new Error("bundle_active_cache_corrupt");
          const bytes = await download(bundle);
          const staging = await mkdtemp(join(stagingRoot, "bundle-"));
          try {
            manifest = await extract(bytes, staging);
            if (!Object.hasOwn(manifest.files, bundle.entry))
              throw new Error("bundle_entry_missing");
            await writeFile(join(staging, MANIFEST), JSON.stringify(manifest), {
              flag: "wx",
              mode: 0o600,
            });
            const destination = join(options.cacheRoot, bundle.sha256);
            await rm(destination, { recursive: true, force: true });
            await rename(staging, destination);
          } finally {
            await rm(staging, { recursive: true, force: true });
          }
        }
        if (!Object.hasOwn(manifest.files, bundle.entry)) throw new Error("bundle_entry_missing");
        const now = new Date();
        await utimes(join(options.cacheRoot, bundle.sha256), now, now);
        const leaseId = randomUUID();
        leases.set(leaseId, { digest: bundle.sha256, manifest });
        await evict(false);
        return { leaseId, sha256: bundle.sha256, entry: bundle.entry, cacheHit };
      });
    },
    read(leaseId: string, path: string) {
      return exclusive(async () => {
        const lease = leases.get(leaseId);
        if (!lease) throw new Error("bundle_lease");
        validateContentBundlePath(path);
        const info = Object.hasOwn(lease.manifest.files, path)
          ? lease.manifest.files[path]
          : undefined;
        if (!info) throw new Error("bundle_resource_missing");
        return checkedRead(join(options.cacheRoot, lease.digest), path, info);
      });
    },
    release(leaseId: string) {
      return exclusive(async () => {
        leases.delete(leaseId);
        await evict(false);
      });
    },
    clear() {
      return exclusive(() => evict(true));
    },
  };
}
