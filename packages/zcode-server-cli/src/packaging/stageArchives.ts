import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, cp, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ServerTarget } from "../runtime/manifest.js";
import { isTarCommand, resolveHostTarCommand } from "./tarCommand.js";

export async function runPackagingCommand(
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    // Bug 原因：Windows runner 的 PATH 可能优先命中 Git Bash GNU tar，且系统没有
    // Info-ZIP；统一把逻辑 tar 与 Windows 上的逻辑 zip 映射到 System32 bsdtar。
    const useWindowsTarForZip = command === "zip" && process.platform === "win32";
    const resolvedCommand =
      command === "tar" || useWindowsTarForZip ? resolveHostTarCommand() : command;
    const baseArgs = useWindowsTarForZip ? ["-acf", ...args.slice(1)] : [...args];
    // Bug 原因：COPYFILE_DISABLE 只能阻止 AppleDouble `._*`，bsdtar 仍会把 provenance/xattr
    // 写入 PAX header。Linux 解压时会为每个条目输出 unknown extended header，既刷爆连接日志，
    // 也可能在真实安装错误发生时把 stderr 根因淹没；macOS 打包必须同时禁用 xattr。
    const env = isTarCommand(resolvedCommand)
      ? { ...process.env, COPYFILE_DISABLE: "1" }
      : process.env;
    const commandArgs =
      command === "tar" && process.platform === "darwin"
        ? ["--no-xattrs", ...baseArgs]
        : baseArgs;
    const child = spawn(resolvedCommand, commandArgs, {
      cwd,
      env,
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.once("error", rejectPromise);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise();
      else
        rejectPromise(
          new Error(
            `${resolvedCommand} ${commandArgs.join(" ")} exited with code ${code ?? "null"}`,
          ),
        );
    });
  });
}

async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relativePath = entry.name;
    const absolutePath = join(root, relativePath);
    if (entry.isDirectory()) {
      for (const nested of await listFiles(absolutePath)) files.push(join(relativePath, nested));
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }
  return files.sort();
}

export async function hashPaths(
  root: string,
  paths: readonly string[],
): Promise<{ sha256: string; sizeBytes: number }> {
  const hash = createHash("sha256");
  let sizeBytes = 0;
  for (const relativePath of [...paths].sort()) {
    const absolutePath = join(root, relativePath);
    const pathStat = await stat(absolutePath);
    const files = pathStat.isDirectory()
      ? (await listFiles(absolutePath)).map((file) => join(relativePath, file))
      : [relativePath];
    for (const file of files.sort()) {
      const contents = await readFile(join(root, file));
      hash.update(`${file}\0`);
      hash.update(contents);
      sizeBytes += contents.byteLength;
    }
  }
  return { sha256: hash.digest("hex"), sizeBytes };
}

export async function createComponentArchive(
  releaseDir: string,
  outputDir: string,
  target: ServerTarget,
  id: string,
  paths: readonly string[],
): Promise<{ archivePath: string; sha256: string; sizeBytes: number }> {
  const info = await hashPaths(releaseDir, paths);
  const componentRoot = join(outputDir, ".components", `${id}-${info.sha256.slice(0, 12)}`);
  await rm(componentRoot, { force: true, recursive: true });
  await mkdir(componentRoot, { recursive: true });
  for (const relativePath of paths) {
    const source = join(releaseDir, relativePath);
    try {
      await access(source);
    } catch {
      continue;
    }
    const targetPath = join(componentRoot, relativePath);
    await mkdir(dirname(targetPath), { recursive: true });
    await cp(source, targetPath, { recursive: true, dereference: true });
  }
  const extension = target.startsWith("win32-") ? "zip" : "tar.gz";
  const archivePath = join(outputDir, "components", target, `${id}-${info.sha256}.${extension}`);
  await mkdir(dirname(archivePath), { recursive: true });
  await rm(archivePath, { force: true });
  if (extension === "zip") {
    await runPackagingCommand("zip", ["-qr", archivePath, "."], componentRoot);
  } else {
    await runPackagingCommand("tar", ["-czf", archivePath, "."], componentRoot);
  }
  await rm(componentRoot, { force: true, recursive: true });
  return { archivePath, ...info };
}
