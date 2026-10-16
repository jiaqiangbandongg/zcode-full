import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readlink,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzip, gzip } from "node:zlib";
import{ describe, expect, it } from "vitest";
import { promisify } from "node:util";
import {
  createTarGzArchive,
  extractTarGzArchive,
} from "@zcode/server/remote/localTarGz.js";

// Windows 上 symlink 需要管理员权限或开发者模式，跳过相关用例
const isWindows = process.platform === "win32";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

describe("local tar.gz archive helper", () => {
  it("creates and extracts directory entries without a system tar binary", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-local-tar-"));
    const sourceDir = join(rootDir, "source");
    const archivePath = join(rootDir, "archive.tar.gz");
    const extractDir = join(rootDir, "extract");

    await mkdir(join(sourceDir, "bin"), { recursive: true });
    await writeFile(join(sourceDir, "bin", "node"), "node runtime", "utf8");

    await createTarGzArchive(archivePath, [
      { sourcePath: sourceDir, archivePath: "node/linux-x64" },
    ]);
    await extractTarGzArchive(archivePath, extractDir);

    await expect(
      readFile(join(extractDir, "node", "linux-x64", "bin", "node"), "utf8"),
    ).resolves.toBe("node runtime");
  });

  it("normalizes directory entry modes for POSIX remote extraction", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-local-tar-mode-"));
    const sourceDir = join(rootDir, "source");
    const nestedDir = join(sourceDir, "nested");
    const archivePath = join(rootDir, "archive.tar.gz");

    await mkdir(nestedDir, { recursive: true });
    if (!isWindows) {
      await chmod(sourceDir, 0o700);
      await chmod(nestedDir, 0o700);
    }

    await createTarGzArchive(archivePath, [
      { sourcePath: sourceDir, archivePath: "packages" },
    ]);

    const entries = readTestTarEntries(await gunzipAsync(await readFile(archivePath)));
    expect(
      entries.filter((entry) => entry.typeFlag === "5").map((entry) => entry.mode),
    ).toEqual([0o755, 0o755]);
  });

  it("rejects path traversal entries while extracting", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-local-tar-"));
    const sourceFile = join(rootDir, "evil.txt");
    const archivePath = join(rootDir, "evil.tar.gz");
    const extractDir = join(rootDir, "extract");

    await writeFile(sourceFile, "evil", "utf8");
    await createTarGzArchive(archivePath, [
      { sourcePath: sourceFile, archivePath: "../evil.txt" },
    ]);

    await expect(extractTarGzArchive(archivePath, extractDir)).rejects.toThrow(
      /unsafe tar entry path/u,
    );
  });

  (isWindows ? it.skip : it)("preserves safe relative symlinks while creatingand extracting archives", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-local-tar-"));
    const sourceDir = join(rootDir, "source");
    const archivePath = join(rootDir, "archive.tar.gz");
    const extractDir = join(rootDir, "extract");

    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "target.txt"), "target content", "utf8");
    await symlink("target.txt", join(sourceDir, "link.txt"));

    await createTarGzArchive(archivePath, [
      { sourcePath: sourceDir, archivePath: "package" },
    ]);
    await extractTarGzArchive(archivePath, extractDir);

    const extractedLinkPath = join(extractDir, "package", "link.txt");
    await expect(lstat(extractedLinkPath).then((stats) => stats.isSymbolicLink())).resolves.toBe(
      true,
    );
    await expect(readlink(extractedLinkPath)).resolves.toBe("target.txt");
    await expect(readFile(extractedLinkPath, "utf8")).resolves.toBe("target content");
  });

  it("rejects symlink targets that escape the extraction root", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-local-tar-"));
    const archivePath = join(rootDir, "unsafe-link.tar.gz");
    const extractDir = join(rootDir, "extract");

    await writeFile(
      archivePath,
      await gzipAsync(
        Buffer.concat([
          createTestTarHeader({
            entryPath: "package/link.txt",
            linkName: "../../outside.txt",
            mode: 0o777,
            size: 0,
            typeFlag: "2",
          }),
          Buffer.alloc(1024),
        ]),
      ),
    );

    await expect(extractTarGzArchive(archivePath, extractDir)).rejects.toThrow(
      /unsafe tar symlink target/u,
    );
  });

  (isWindows ? it.skip : it)("rejects unsafe local symlink targets while creating archives", async ()=> {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-local-tar-"));
    const sourceDir = join(rootDir, "source");
    const outsideFile = join(rootDir, "outside.txt");
    const archivePath = join(rootDir, "unsafe-local-link.tar.gz");

    await mkdir(sourceDir, { recursive: true });
    await writeFile(outsideFile, "outside", "utf8");
    await symlink(outsideFile, join(sourceDir, "link.txt"));

    await expect(
      createTarGzArchive(archivePath, [
        { sourcePath: sourceDir, archivePath: "package" },
      ]),
    ).rejects.toThrow(/unsafe tar symlink target/u);
  });

  (isWindows ? it.skip : it)("rejects local symlink targets that are too long for ustar", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-local-tar-"));
    const sourceDir = join(rootDir, "source");
    const archivePath = join(rootDir, "long-link.tar.gz");

    await mkdir(sourceDir, { recursive: true });
    await symlink("nested/".repeat(16), join(sourceDir, "link.txt"));

    await expect(
      createTarGzArchive(archivePath, [
        { sourcePath: sourceDir, archivePath: "package" },
      ]),
    ).rejects.toThrow(/tar symlink target is too long/u);
  });
});

function createTestTarHeader(options: {
  entryPath: string;
  linkName?: string;
  mode: number;
  size: number;
  typeFlag: "0" | "2" | "5";
}): Buffer {
  const header = Buffer.alloc(512);
  writeTestTarString(header, options.entryPath, 0, 100);
  writeTestTarOctal(header, options.mode, 100, 8);
  writeTestTarOctal(header, 0, 108, 8);
  writeTestTarOctal(header, 0, 116, 8);
  writeTestTarOctal(header, options.size, 124, 12);
  writeTestTarOctal(header, 0, 136, 12);
  header.fill(0x20, 148, 156);
  writeTestTarString(header, options.typeFlag, 156, 1);
  if (options.linkName) {
    writeTestTarString(header, options.linkName, 157, 100);
  }
  writeTestTarString(header, "ustar", 257, 6);
  writeTestTarString(header, "00", 263, 2);

  let checksum = 0;
  for (const byte of header) {
    checksum += byte;
  }
  writeTestTarString(header, checksum.toString(8).padStart(6, "0").slice(-6), 148, 6);
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function writeTestTarString(
  buffer: Buffer,
  value: string,
  offset: number,
  length: number,
): void {
  buffer.write(value, offset, length, "utf8");
}

function writeTestTarOctal(
  buffer: Buffer,
  value: number,
  offset: number,
  length: number,
): void {
  const encoded = Math.trunc(value).toString(8).padStart(length - 1, "0");
  writeTestTarString(buffer, encoded.slice(-(length - 1)), offset, length - 1);
}

function readTestTarEntries(
  archive: Buffer,
): Array<{ mode: number; typeFlag: string }> {
  const entries: Array<{ mode: number; typeFlag: string }> = [];
  let offset = 0;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      break;
    }
    const size = readTestTarOctal(header, 124, 12);
    entries.push({
      mode: readTestTarOctal(header, 100, 8),
      typeFlag: String.fromCharCode(header[156] ?? 0),
    });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function readTestTarOctal(buffer: Buffer, offset: number, length: number): number {
  const field = buffer.subarray(offset, offset + length);
  const nullIndex = field.indexOf(0);
  const raw = field
    .subarray(0, nullIndex === -1 ? field.length : nullIndex)
    .toString("ascii")
    .trim();
  return raw ? Number.parseInt(raw, 8) : 0;
}
