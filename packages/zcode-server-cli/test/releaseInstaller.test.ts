import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveServerLayout } from "../src/runtime/paths.js";
import { ReleaseInstaller } from "../src/runtime/releaseInstaller.js";
import { writeStableLauncher } from "../src/runtime/stableLauncher.js";

describe("release installer", () => {
  it("rejects a release version before constructing a path", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-release-installer-invalid-"));
    const layout = resolveServerLayout(join(root, "server"));
    await expect(new ReleaseInstaller(layout).installArchive({ archivePath: join(root, "missing.tar.gz"), target: "linux-x64", version: "../escape" })).rejects.toThrow(/Invalid release version/);
  });

  it("installs a tar release, writes pending and creates a stable launcher", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-release-installer-"));
    const layout = resolveServerLayout(join(root, "server"));
    const archiveRoot = join(root, "zcode-server-linux-x64");
    await mkdir(join(archiveRoot, "runtime"), { recursive: true });
    await writeFile(join(archiveRoot, "runtime", "node"), "node", "utf8");
    await writeFile(join(archiveRoot, "runtime", "server-cli.js"), "", "utf8");
    await writeFile(join(archiveRoot, "runtime", "server-core.js"), "", "utf8");
    await writeFile(join(archiveRoot, "runtime", "zcode.cjs"), "", "utf8");
    await writeFile(join(archiveRoot, "runtime", "package.json"), JSON.stringify({ type: "module" }), "utf8");
    await writeFile(join(archiveRoot, "manifest.json"), JSON.stringify({ product: "zcode-server", target: "linux-x64", appVersion: "1.2.3", nodeVersion: "22.16.0", entrypoints: { cli: "runtime/server-cli.js", core: "runtime/server-core.js", agent: "runtime/zcode.cjs" }, native: ["node-pty"] }), "utf8");
    const archivePath = join(root, "release.tar.gz");
    const { execFile } = await import("node:child_process");
    await new Promise<void>((resolve, reject) => execFile("tar", ["-czf", archivePath, "zcode-server-linux-x64"], { cwd: root }, (error) => error ? reject(error) : resolve()));
    const installed = await new ReleaseInstaller(layout).installArchive({ archivePath, target: "linux-x64", version: "1.2.3" });
    expect(installed.target).toBe("linux-x64");
    expect(JSON.parse(await readFile(layout.pendingFile, "utf8"))).toMatchObject({ version: "1.2.3" });
    const launcher = await readFile(join(layout.stableBinDir, "zcode"), "utf8");
    expect(launcher).toContain("current.json");
    expect(launcher).toContain('"$ROOT/releases"/*)');
  });

  it("installs a Windows zip and writes a launcher that is safe for quoted paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-release-installer-win-"));
    const layout = resolveServerLayout(join(root, "server"));
    const archiveRoot = join(root, "zcode-server-win32-x64");
    await mkdir(join(archiveRoot, "runtime"), { recursive: true });
    await writeFile(join(archiveRoot, "runtime", "node.exe"), "node", "utf8");
    await writeFile(join(archiveRoot, "runtime", "server-cli.js"), "", "utf8");
    await writeFile(join(archiveRoot, "runtime", "server-core.js"), "", "utf8");
    await writeFile(join(archiveRoot, "runtime", "zcode.cjs"), "", "utf8");
    await writeFile(join(archiveRoot, "manifest.json"), JSON.stringify({ product: "zcode-server", target: "win32-x64", appVersion: "1.2.4", nodeVersion: "22.16.0", entrypoints: { cli: "runtime/server-cli.js", core: "runtime/server-core.js", agent: "runtime/zcode.cjs" }, native: ["node-pty"] }), "utf8");
    const archivePath = join(root, "release.zip");
    const { execFile } = await import("node:child_process");
    // Bugfix: Windows 本机没有 Info-ZIP 的 `zip` 命令；System32 自带 bsdtar，`tar -a`
    // 可按 .zip 后缀写归档，与产品 stageRelease 在 Windows 上的产包方式一致。
    await new Promise<void>((resolve, reject) => execFile(
      process.platform === "win32" ? "tar" : "zip",
      process.platform === "win32"
        ? ["-acf", archivePath, "zcode-server-win32-x64"]
        : ["-qr", archivePath, "zcode-server-win32-x64"],
      { cwd: root },
      (error) => error ? reject(error) : resolve(),
    ));
    await new ReleaseInstaller(layout).installArchive({ archivePath, target: "win32-x64", version: "1.2.4" });
    const launcher = await readFile(join(layout.stableBinDir, "zcode.cmd"), "utf8");
    expect(launcher).toContain("ZCODE_SERVER_ROOT");
    expect(launcher).toContain("Invalid current ZCode Server release");
  });

  // Bugfix: 该用例验证 POSIX shell 版 stable launcher 的 fail-closed 输出，靠 shebang
  // 直接执行 shell 脚本；Windows 无法 spawn 无扩展名脚本（ENOENT），只在 POSIX 宿主运行。
  it.skipIf(process.platform === "win32")("fails closed when the POSIX stable launcher reads an external current release", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-release-launcher-boundary-"));
    const layout = resolveServerLayout(join(root, "server"));
    await writeStableLauncher(layout, "linux");
    await writeFile(layout.currentFile, JSON.stringify({ version: "1.0.0", releaseDir: join(root, "outside") }), "utf8");
    const { execFile } = await import("node:child_process");
    await expect(new Promise<void>((resolve, reject) => {
      execFile(join(layout.stableBinDir, "zcode"), [], (error, _stdout, stderr) => {
        if (error) reject(new Error(`${error.message}: ${stderr}`));
        else resolve();
      });
    })).rejects.toThrow(/Invalid current ZCode Server release/);
  });

  it("reuses an identical immutable release without deleting or replacing its live directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-release-installer-immutable-"));
    const layout = resolveServerLayout(join(root, "server"));
    const archiveRoot = join(root, "zcode-server-linux-x64");
    await mkdir(join(archiveRoot, "runtime"), { recursive: true });
    await writeFile(join(archiveRoot, "runtime", "node"), "node", "utf8");
    await writeFile(join(archiveRoot, "runtime", "server-cli.js"), "", "utf8");
    await writeFile(join(archiveRoot, "runtime", "server-core.js"), "", "utf8");
    await writeFile(join(archiveRoot, "runtime", "zcode.cjs"), "", "utf8");
    await writeFile(join(archiveRoot, "runtime", "package.json"), JSON.stringify({ type: "module" }), "utf8");
    await writeFile(join(archiveRoot, "manifest.json"), JSON.stringify({
      product: "zcode-server",
      target: "linux-x64",
      appVersion: "2.0.0",
      nodeVersion: "22.16.0",
      entrypoints: { cli: "runtime/server-cli.js", core: "runtime/server-core.js", agent: "runtime/zcode.cjs" },
      native: ["node-pty"],
    }), "utf8");
    const archivePath = join(root, "release.tar.gz");
    const { execFile } = await import("node:child_process");
    await new Promise<void>((resolve, reject) => execFile("tar", ["-czf", archivePath, "zcode-server-linux-x64"], { cwd: root }, (error) => error ? reject(error) : resolve()));
    const installer = new ReleaseInstaller(layout);
    const [first, concurrent] = await Promise.all([
      installer.installArchive({ archivePath, target: "linux-x64", version: "2.0.0" }),
      installer.installArchive({ archivePath, target: "linux-x64", version: "2.0.0" }),
    ]);
    expect(concurrent.releaseDir).toBe(first.releaseDir);
    const firstDirectory = await stat(first.releaseDir);
    const second = await installer.installArchive({ archivePath, target: "linux-x64", version: "2.0.0" });

    expect(second.releaseDir).toBe(first.releaseDir);
    expect((await stat(second.releaseDir)).ino).toBe(firstDirectory.ino);
    await expect(readFile(join(second.releaseDir, "runtime", "node"), "utf8")).resolves.toBe("node");
    expect((await readdir(layout.releasesDir)).filter((entry) => entry.startsWith(".incoming-"))).toEqual([]);
  });

  it("rejects an existing release whose immutable archive identity is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-release-installer-conflict-"));
    const layout = resolveServerLayout(join(root, "server"));
    const archiveRoot = join(root, "zcode-server-linux-x64");
    await mkdir(join(archiveRoot, "runtime"), { recursive: true });
    await writeFile(join(archiveRoot, "runtime", "node"), "node", "utf8");
    await writeFile(join(archiveRoot, "runtime", "server-cli.js"), "", "utf8");
    await writeFile(join(archiveRoot, "runtime", "server-core.js"), "", "utf8");
    await writeFile(join(archiveRoot, "runtime", "zcode.cjs"), "", "utf8");
    await writeFile(join(archiveRoot, "manifest.json"), JSON.stringify({
      product: "zcode-server",
      target: "linux-x64",
      appVersion: "2.1.0",
      nodeVersion: "22.16.0",
      entrypoints: { cli: "runtime/server-cli.js", core: "runtime/server-core.js", agent: "runtime/zcode.cjs" },
      native: ["node-pty"],
    }), "utf8");
    const archivePath = join(root, "release.tar.gz");
    const { execFile } = await import("node:child_process");
    await new Promise<void>((resolve, reject) => execFile("tar", ["-czf", archivePath, "zcode-server-linux-x64"], { cwd: root }, (error) => error ? reject(error) : resolve()));
    const installer = new ReleaseInstaller(layout);
    const first = await installer.installArchive({ archivePath, target: "linux-x64", version: "2.1.0" });
    await writeFile(join(first.releaseDir, "runtime", "server-core.js"), "tampered", "utf8");

    await expect(
      installer.installArchive({ archivePath, target: "linux-x64", version: "2.1.0" }),
    ).rejects.toThrow(/immutable release conflict/);
  });
});
