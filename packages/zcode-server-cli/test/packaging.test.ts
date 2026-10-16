import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectBareModuleSpecifiers,
  isNodePtyRuntimePath,
  resolveProductionPackageClosure,
  stageRelease,
} from "../src/packaging/stage.js";
import { resolveHostTarCommand } from "../src/packaging/tarCommand.js";

const execFileAsync = promisify(execFile);
async function runTar(args: string[]): Promise<void> {
  await execFileAsync(resolveHostTarCommand(), args);
}

const temporaryDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "zcode-server-stage-test-"));
  temporaryDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(temporaryDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

interface FakePackageSpec {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  files?: Record<string, string>;
}

async function writeFakePackage(
  nodeModulesDir: string,
  name: string,
  spec: FakePackageSpec = {},
): Promise<string> {
  const packageDir = join(nodeModulesDir, ...name.split("/"));
  await mkdir(packageDir, { recursive: true });
  await writeFile(
    join(packageDir, "package.json"),
    JSON.stringify({
      name,
      version: "0.0.1",
      main: "./index.js",
      dependencies: spec.dependencies,
      optionalDependencies: spec.optionalDependencies,
      devDependencies: spec.devDependencies,
    }),
    "utf8",
  );
  await writeFile(join(packageDir, "index.js"), "module.exports = {};\n", "utf8");
  for (const [relativePath, contents] of Object.entries(spec.files ?? {})) {
    const filePath = join(packageDir, ...relativePath.split("/"));
    await mkdir(join(filePath, ".."), { recursive: true });
    await writeFile(filePath, contents, "utf8");
  }
  return packageDir;
}

describe("collectBareModuleSpecifiers", () => {
  it("extracts bare imports, dynamic imports and requires as package names", () => {
    const source = [
      'import { Hono } from "hono";',
      'import { serve } from "@hono/node-server";',
      'const pty = await import("node-pty");',
      'const utils = require("node-pty/lib/utils");',
    ].join("\n");
    const names = collectBareModuleSpecifiers(source);
    expect(names).toContain("hono");
    expect(names).toContain("@hono/node-server");
    expect(names).toContain("node-pty");
  });

  it("ignores node builtins and relative specifiers", () => {
    const source = [
      'import { readFile } from "node:fs/promises";',
      'import local from "./local.js";',
      'import parent from "../parent.js";',
    ].join("\n");
    expect(collectBareModuleSpecifiers(source).size).toBe(0);
  });
});

describe("resolveProductionPackageClosure", () => {
  it("collects transitive production dependencies but not dev dependencies", async () => {
    const root = await makeTempDir();
    const nodeModulesDir = join(root, "node_modules");
    await writeFakePackage(nodeModulesDir, "pkg-a", {
      dependencies: { "pkg-b": "*" },
      devDependencies: { "pkg-dev": "*" },
    });
    await writeFakePackage(nodeModulesDir, "pkg-b", { dependencies: { "@scope/pkg-c": "*" } });
    await writeFakePackage(nodeModulesDir, "@scope/pkg-c");
    await writeFakePackage(nodeModulesDir, "pkg-dev");

    const closure = await resolveProductionPackageClosure(["pkg-a"], nodeModulesDir);
    expect([...closure.keys()].sort()).toEqual(["@scope/pkg-c", "pkg-a", "pkg-b"]);
  });

  it("skips missing optional dependencies and unknown entry packages", async () => {
    const root = await makeTempDir();
    const nodeModulesDir = join(root, "node_modules");
    await writeFakePackage(nodeModulesDir, "pkg-a", {
      optionalDependencies: { "pkg-missing-optional": "*" },
    });

    const closure = await resolveProductionPackageClosure(
      ["pkg-a", "pkg-not-installed"],
      nodeModulesDir,
    );
    expect([...closure.keys()]).toEqual(["pkg-a"]);
  });
});

describe("isNodePtyRuntimePath", () => {
  it("keeps runtime files and the target platform prebuild only", () => {
    expect(isNodePtyRuntimePath("package.json", "linux-x64")).toBe(true);
    expect(isNodePtyRuntimePath("lib/index.js", "linux-x64")).toBe(true);
    expect(isNodePtyRuntimePath("typings/node-pty.d.ts", "linux-x64")).toBe(true);
    expect(isNodePtyRuntimePath("prebuilds/linux-x64/pty.node", "linux-x64")).toBe(true);
    expect(isNodePtyRuntimePath("LICENSE", "linux-x64")).toBe(true);
  });

  it("drops host build outputs, sources and other platform prebuilds", () => {
    expect(isNodePtyRuntimePath("build/Release/pty.node", "linux-x64")).toBe(false);
    expect(isNodePtyRuntimePath("build/Debug/pty.node", "linux-x64")).toBe(false);
    expect(isNodePtyRuntimePath("prebuilds/darwin-arm64/pty.node", "linux-x64")).toBe(false);
    expect(isNodePtyRuntimePath("src/unix/pty.cc", "linux-x64")).toBe(false);
    expect(isNodePtyRuntimePath("deps/winpty/x.h", "linux-x64")).toBe(false);
    expect(isNodePtyRuntimePath("scripts/post-install.js", "linux-x64")).toBe(false);
  });
});

describe("stageRelease", () => {
  async function makeStageFixture(): Promise<{
    distDir: string;
    workspaceNodeModulesDir: string;
    agentBundlePath: string;
    nodeBinaryPath: string;
    outputDir: string;
  }> {
    const root = await makeTempDir();
    const distDir = join(root, "dist");
    await mkdir(distDir, { recursive: true });
    await writeFile(
      join(distDir, "server-cli.js"),
      'import "fake-dep";\nimport "node-pty";\n',
      "utf8",
    );
    await writeFile(join(distDir, "server-core.js"), 'import "node:fs";\n', "utf8");

    const workspaceNodeModulesDir = join(root, "node_modules");
    await writeFakePackage(workspaceNodeModulesDir, "fake-dep", {
      dependencies: { "fake-transitive": "*" },
    });
    await writeFakePackage(workspaceNodeModulesDir, "fake-transitive");
    await writeFakePackage(workspaceNodeModulesDir, "node-pty", {
      files: {
        LICENSE: "node-pty license\n",
        "lib/index.js": "module.exports = {};\n",
        "typings/node-pty.d.ts": "export {};\n",
        "build/Release/pty.node": "host-binary",
        "prebuilds/darwin-arm64/pty.node": "darwin-binary",
        "prebuilds/darwin-arm64/spawn-helper": "darwin-helper",
        "prebuilds/win32-x64/pty.node": "windows-binary",
      },
    });
    await writeFakePackage(workspaceNodeModulesDir, "@lydell/node-pty-linux-x64", {
      files: { "prebuilds/linux-x64/pty.node": "linux-binary" },
    });

    const agentBundlePath = join(root, "zcode.cjs");
    await writeFile(agentBundlePath, "// fake agent bundle\n", "utf8");
    const nodeBinaryPath = join(root, "node-binary");
    await writeFile(nodeBinaryPath, "#!/bin/sh\nexit 0\n", "utf8");

    const outputDir = join(root, "out");
    const notices = {
      thirdParty: "Copyright npm\nComplete terms\n",
      node: "Copyright Node\nComplete runtime terms\n",
      nodeSource: '{"version":"22.16.0"}\n',
    };
    return { distDir, workspaceNodeModulesDir, agentBundlePath, nodeBinaryPath, outputDir, notices };
  }

  async function writeFakeNativeTools(toolsDir: string, tools: Record<string, string>): Promise<void> {
    for (const [tool, binaryName] of Object.entries(tools)) {
      await mkdir(join(toolsDir, tool), { recursive: true });
      await writeFile(join(toolsDir, tool, binaryName), tool, "utf8");
      await writeFile(join(toolsDir, tool, "THIRD-PARTY-NOTICES.txt"), `Copyright ${tool}\nFull terms\n`, "utf8");
      await writeFile(join(toolsDir, tool, "SOURCES.json"), JSON.stringify({ tool }), "utf8");
    }
  }

  it("assembles the release layout for a linux target", async () => {
    const fixture = await makeStageFixture();
    const staged = await stageRelease({
      target: "linux-x64",
      appVersion: "9.9.9-test",
      archive: false,
      ...fixture,
    });

    const releaseDir = staged.releaseDir;
    expect(releaseDir.endsWith("zcode-server-linux-x64")).toBe(true);

    const launcher = await readFile(join(releaseDir, "bin", "zcode"), "utf8");
    expect(launcher).toContain('"$DIR/runtime/node"');
    expect(launcher).toContain('"$DIR/runtime/server-cli.js"');
    const launcherStat = await stat(join(releaseDir, "bin", "zcode"));
    // Bugfix: NTFS 不保留 POSIX exec 位（Windows 上 stat.mode 恒无 0o111 位），
    // 可执行性断言只在 POSIX 宿主上生效；Windows 宿主仍验证文件存在与内容。
    if (process.platform !== "win32") expect(launcherStat.mode & 0o111).not.toBe(0);

    const runtimePackageJson = JSON.parse(
      await readFile(join(releaseDir, "runtime", "package.json"), "utf8"),
    ) as { type?: string };
    expect(runtimePackageJson.type).toBe("module");

    for (const relativePath of [
      "runtime/server-cli.js",
      "runtime/server-core.js",
      "runtime/zcode.cjs",
      "runtime/node",
      "runtime/node_modules/fake-dep/package.json",
      "runtime/node_modules/fake-transitive/package.json",
      "runtime/node_modules/node-pty/lib/index.js",
      "runtime/node_modules/node-pty/LICENSE",
      "runtime/THIRD-PARTY-NOTICES.md",
      "runtime/LICENSE.node.txt",
      "runtime/NODE-SOURCES.json",
      "runtime/licenses/agent/THIRD-PARTY-NOTICES.md",
      "runtime/node_modules/node-pty/prebuilds/linux-x64/pty.node",
    ]) {
      await expect(stat(join(releaseDir, ...relativePath.split("/")))).resolves.toBeTruthy();
    }

    const nodeStat = await stat(join(releaseDir, "runtime", "node"));
    // Bugfix: 同上，NTFS 无 POSIX exec 位，可执行性断言只在 POSIX 宿主生效。
    if (process.platform !== "win32") expect(nodeStat.mode & 0o111).not.toBe(0);

    // 交叉打包安全性：宿主编译产物与非目标平台 prebuilds 不进入发行包。
    await expect(stat(join(releaseDir, "runtime/node_modules/node-pty/build"))).rejects.toThrow();
    await expect(
      stat(join(releaseDir, "runtime/node_modules/node-pty/prebuilds/darwin-arm64")),
    ).rejects.toThrow();

    // linux 平台 pty.node 由 @lydell 平台包补齐。
    const linuxPty = await readFile(
      join(releaseDir, "runtime/node_modules/node-pty/prebuilds/linux-x64/pty.node"),
      "utf8",
    );
    expect(linuxPty).toBe("linux-binary");

    const manifest = JSON.parse(await readFile(join(releaseDir, "manifest.json"), "utf8")) as {
      product: string;
      target: string;
      appVersion: string;
      nodeVersion: string;
      entrypoints: { cli: string; core: string; agent: string };
    };
    expect(manifest.product).toBe("zcode-server");
    expect(manifest.target).toBe("linux-x64");
    expect(manifest.appVersion).toBe("9.9.9-test");
    expect(manifest.nodeVersion).toBe("22.16.0");
    expect(manifest.entrypoints).toEqual({
      cli: "runtime/server-cli.js",
      core: "runtime/server-core.js",
      agent: "runtime/zcode.cjs",
    });

    expect(staged.packagedDependencies).toEqual(["fake-dep", "fake-transitive", "node-pty"]);
    expect(staged.archivePath).toBeNull();
  });

  it("keeps official darwin prebuilds including spawn-helper for darwin targets", async () => {
    const fixture = await makeStageFixture();
    const staged = await stageRelease({
      target: "darwin-arm64",
      appVersion: "9.9.9-test",
      archive: false,
      ...fixture,
    });
    const prebuildDir = join(
      staged.releaseDir,
      "runtime/node_modules/node-pty/prebuilds/darwin-arm64",
    );
    await expect(stat(join(prebuildDir, "pty.node"))).resolves.toBeTruthy();
    const helperStat = await stat(join(prebuildDir, "spawn-helper"));
    // Bugfix: 同上，NTFS 无 POSIX exec 位，可执行性断言只在 POSIX 宿主生效。
    if (process.platform !== "win32") expect(helperStat.mode & 0o111).not.toBe(0);
  });

  it("stages a Windows target with a cmd launcher and zip archive", async () => {
    const fixture = await makeStageFixture();
    const toolsDir = join(await makeTempDir(), "tools");
    await writeFakeNativeTools(toolsDir, { ripgrep: "rg.exe", ugrep: "ugrep.exe" });
    const staged = await stageRelease({ target: "win32-x64", appVersion: "9.9.9-test", nativeToolsDir: toolsDir, ...fixture });
    expect(staged.archivePath).toMatch(/\.zip$/u);
    expect(await readFile(join(staged.releaseDir, "bin", "zcode.cmd"), "utf8")).toContain("node.exe");
    await expect(stat(join(staged.releaseDir, "runtime", "node.exe"))).resolves.toBeTruthy();
    await expect(stat(join(staged.releaseDir, "runtime", "tools", "ripgrep", "rg.exe"))).resolves.toBeTruthy();
    await expect(stat(join(staged.releaseDir, "runtime", "tools", "ugrep", "ugrep.exe"))).resolves.toBeTruthy();
    await expect(stat(join(staged.releaseDir, "runtime", "tools", "ugrep", "THIRD-PARTY-NOTICES.txt"))).resolves.toBeTruthy();
    await expect(stat(join(staged.releaseDir, "runtime", "tools", "bfs"))).rejects.toThrow();
  });

  it("每个可独立下载的组件归档都携带适用的第三方声明", async () => {
    const fixture = await makeStageFixture();
    const toolsDir = join(await makeTempDir(), "tools");
    await writeFakeNativeTools(toolsDir, { bfs: "bfs", ripgrep: "rg", ugrep: "ugrep" });
    const staged = await stageRelease({ target: "linux-x64", appVersion: "9.9.9-test", nativeToolsDir: toolsDir, ...fixture });
    const manifest = JSON.parse(await readFile(join(staged.releaseDir, "manifest.json"), "utf8")) as {
      components: Array<{ id: string; archivePath: string }>;
    };
    const expected: Record<string, string[]> = {
      "node-runtime": ["runtime/LICENSE.node.txt", "runtime/NODE-SOURCES.json"],
      "server-runtime": ["runtime/THIRD-PARTY-NOTICES.md", "runtime/node_modules/node-pty/LICENSE"],
      "agent-runtime": ["runtime/licenses/agent/THIRD-PARTY-NOTICES.md"],
      "native-search-tools": ["runtime/tools/ripgrep/THIRD-PARTY-NOTICES.txt", "runtime/tools/ugrep/SOURCES.json"],
    };
    expect(manifest.components.map((component) => component.id).sort()).toEqual(Object.keys(expected).sort());
    const extractRoot = await makeTempDir();
    for (const component of manifest.components) {
      const extractDir = join(extractRoot, component.id);
      await mkdir(extractDir, { recursive: true });
      await runTar(["-xf", join(fixture.outputDir, component.archivePath), "-C", extractDir]);
      for (const member of expected[component.id] ?? []) {
        expect(await readFile(join(extractDir, member))).toEqual(await readFile(join(staged.releaseDir, member)));
      }
    }
  });

  it("工具目录缺少声明或声明参数为空时拒绝组装发行包", async () => {
    const fixture = await makeStageFixture();
    const toolsDir = join(await makeTempDir(), "tools");
    await writeFakeNativeTools(toolsDir, { bfs: "bfs", ripgrep: "rg", ugrep: "ugrep" });
    await rm(join(toolsDir, "ripgrep", "THIRD-PARTY-NOTICES.txt"));
    await expect(
      stageRelease({ target: "linux-x64", appVersion: "9.9.9-test", archive: false, nativeToolsDir: toolsDir, ...fixture }),
    ).rejects.toThrow(/ENOENT/u);
    await expect(
      stageRelease({
        target: "linux-x64",
        appVersion: "9.9.9-test",
        archive: false,
        ...fixture,
        notices: { ...fixture.notices, node: " " },
      }),
    ).rejects.toThrow(/Missing distribution notice: node/u);
  });

  it("stages the official plugin set and excludes the on-demand superpowers package", async () => {
    const fixture = await makeStageFixture();
    const officialPluginsDir = join(await makeTempDir(), "packages");
    const pluginNames = [
      "android-emulator-plugin",
      "browser-use-plugin",
      "document-skills-plugin",
      "ios-simulator-plugin",
      "restore-legacy-sessions-plugin",
      "skill-creator-plugin",
      "zcode-guide-plugin",
      "superpowers-plugin",
    ];
    for (const name of pluginNames) {
      await mkdir(join(officialPluginsDir, name), { recursive: true });
      await writeFile(join(officialPluginsDir, name, "README.md"), name, "utf8");
    }

    const staged = await stageRelease({
      target: "linux-x64",
      appVersion: "9.9.9-test",
      archive: false,
      officialPluginsDir,
      ...fixture,
    });

    for (const name of pluginNames.filter((name) => name !== "superpowers-plugin")) {
      await expect(stat(join(staged.releaseDir, "runtime/packages", name, "README.md"))).resolves.toBeTruthy();
    }
    await expect(
      stat(join(staged.releaseDir, "runtime/packages/superpowers-plugin")),
    ).rejects.toThrow();
    const manifest = JSON.parse(await readFile(join(staged.releaseDir, "manifest.json"), "utf8")) as {
      plugins?: string[];
      components?: Array<{ id: string }>;
    };
    expect(manifest.plugins).toEqual([
      "android-emulator",
      "browser-use",
      "document-skills",
      "ios-simulator",
      "restore-legacy-sessions",
      "skill-creator",
      "zcode-guide",
    ]);
    expect(manifest.components?.some((component) => component.id === "official-plugins")).toBe(true);
  });

  it("removes stale component archives before restaging a target", async () => {
    const fixture = await makeStageFixture();
    const staleDir = join(fixture.outputDir, "components", "linux-x64");
    await mkdir(staleDir, { recursive: true });
    await writeFile(join(staleDir, "stale-component.tar.gz"), "stale", "utf8");

    await stageRelease({ target: "linux-x64", appVersion: "9.9.9-test", archive: false, ...fixture });

    await expect(stat(join(staleDir, "stale-component.tar.gz"))).rejects.toThrow();
  });
});
