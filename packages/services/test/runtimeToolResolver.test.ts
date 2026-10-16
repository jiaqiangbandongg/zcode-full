import { chmodSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendPathEntries,
  buildRuntimeToolEnvPatch,
  findRuntimeToolBinary,
  prependPathEntries,
} from "../src/runtime-tools/runtimeToolResolver.js";

describe("runtimeToolResolver", () => {
  const originalCwd = process.cwd();
  const createdDirs: string[] = [];

  afterEach(() => {
    process.chdir(originalCwd);

    for (const dir of createdDirs.splice(0).reverse()) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("会发现内置 bfs 和 ugrep 并把两个原生目录追加到 PATH", () => {
    const sandboxRoot = mkdtempSync(join(tmpdir(), "zcode-native-search-tools-"));
    createdDirs.push(sandboxRoot);
    const appRepoDir = join(sandboxRoot, "z-code-2");
    const userBinDir = join(sandboxRoot, "user-bin");
    const platformKey = `${process.platform}-${process.arch}`;
    const executableSuffix = process.platform === "win32" ? ".exe" : "";
    const bfsPath = join(
      appRepoDir,
      "packages",
      "desktop",
      "bundled-tools",
      platformKey,
      "bfs",
      `bfs${executableSuffix}`,
    );
    const ugrepPath = join(
      appRepoDir,
      "packages",
      "desktop",
      "bundled-tools",
      platformKey,
      "ugrep",
      `ugrep${executableSuffix}`,
    );
    for (const binaryPath of [bfsPath, ugrepPath]) {
      mkdirSync(dirname(binaryPath), { recursive: true });
      writeFileSync(binaryPath, "native search\n");
      if (process.platform !== "win32") {
        chmodSync(binaryPath, 0o755);
      }
    }
    process.chdir(appRepoDir);

    const envPatch = buildRuntimeToolEnvPatch(["bfs", "ugrep"], {
      PATH: userBinDir,
    });

    expect(realpathSync(envPatch.ZCODE_BFS_BINARY!)).toBe(realpathSync(bfsPath));
    expect(realpathSync(envPatch.ZCODE_UGREP_BINARY!)).toBe(realpathSync(ugrepPath));
    const pathEntries = envPatch.PATH?.split(delimiter) ?? [];
    expect(realpathSync(pathEntries.at(-2)!)).toBe(realpathSync(dirname(bfsPath)));
    expect(realpathSync(pathEntries.at(-1)!)).toBe(realpathSync(dirname(ugrepPath)));
  });

  it("会从 bundled-tools 平台目录发现 ripgrep binary 并追加到 PATH", () => {
    const sandboxRoot = mkdtempSync(join(tmpdir(), "zcode-ripgrep-tool-"));
    createdDirs.push(sandboxRoot);

    const appRepoDir = join(sandboxRoot, "z-code-2");
    const userBinDir = join(sandboxRoot, "user-bin");
    const platformKey = `${process.platform}-${process.arch}`;
    const binaryName = process.platform === "win32" ? "rg.exe" : "rg";
    const binaryPath = join(
      appRepoDir,
      "packages",
      "desktop",
      "bundled-tools",
      platformKey,
      "ripgrep",
      binaryName,
    );
    mkdirSync(dirname(binaryPath), { recursive: true });
    writeFileSync(binaryPath, "rg\n");
    if (process.platform !== "win32") {
      chmodSync(binaryPath, 0o755);
    }

    process.chdir(appRepoDir);

    expect(realpathSync(findRuntimeToolBinary("ripgrep", { PATH: userBinDir })!)).toBe(
      realpathSync(binaryPath),
    );

    const envPatch = buildRuntimeToolEnvPatch(["ripgrep"], {
      PATH: userBinDir,
    });

    expect(realpathSync(envPatch.ZCODE_RG_BINARY!)).toBe(realpathSync(binaryPath));
    expect(realpathSync(envPatch.PATH?.split(delimiter).at(-1) ?? "")).toBe(
      realpathSync(dirname(binaryPath)),
    );
  });

  it("优先使用调用方环境指定的 runtime binary", () => {
    const sandboxRoot = mkdtempSync(join(tmpdir(), "zcode-runtime-tool-env-"));
    createdDirs.push(sandboxRoot);
    const binaryPath = join(sandboxRoot, process.platform === "win32" ? "bfs.exe" : "bfs");
    writeFileSync(binaryPath, "bfs\n");
    if (process.platform !== "win32") {
      chmodSync(binaryPath, 0o755);
    }

    expect(
      findRuntimeToolBinary("bfs", {
        PATH: "",
        ZCODE_BFS_BINARY: binaryPath,
      }),
    ).toBe(binaryPath);
  });

  it("prependPathEntries 会去重并保留前置优先级", () => {
    const currentPath = ["user-bin", "system-bin", "user-bin"].join(delimiter);
    const expectedPath = ["custom-bin", "user-bin", "system-bin"].join(delimiter);
    expect(prependPathEntries(currentPath, ["custom-bin", "user-bin"])).toBe(expectedPath);
  });

  it("appendPathEntries 会去重并保留用户 PATH 优先级", () => {
    const currentPath = ["user-bin", "system-bin", "user-bin"].join(delimiter);
    const expectedPath = ["user-bin", "system-bin", "custom-bin"].join(delimiter);
    expect(appendPathEntries(currentPath, ["custom-bin", "user-bin"])).toBe(expectedPath);
  });
});
