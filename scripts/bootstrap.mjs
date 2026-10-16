#!/usr/bin/env node

import process from "node:process";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { runCommand } from "./spawn-command.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(scriptDir, "..");
const gitCommand = "git";
const withRemoteAssets = process.argv.includes("--with-remote");

function prependPathEntries(pathValue, entries) {
  const currentEntries = pathValue ? pathValue.split(delimiter) : [];
  return [...entries, ...currentEntries].join(delimiter);
}

function resolvePinnedNodeBin() {
  if (process.platform === "win32") {
    return undefined;
  }

  const miseConfigPath = resolve(rootDir, "mise.toml");
  if (!existsSync(miseConfigPath)) {
    return undefined;
  }

  const miseConfig = readFileSync(miseConfigPath, "utf8");
  const match = miseConfig.match(/^\s*node\s*=\s*"([^"]+)"/m);
  const version = match?.[1]?.trim();
  if (!version) {
    return undefined;
  }

  const nvmNodeBin = join(homedir(), ".nvm", "versions", "node", `v${version}`, "bin");
  return existsSync(nvmNodeBin) ? nvmNodeBin : undefined;
}

function resolveUserPnpmBin() {
  if (process.platform === "win32") {
    return undefined;
  }

  const pnpmBin = join(homedir(), "Library", "pnpm");
  return existsSync(join(pnpmBin, "pnpm")) ? pnpmBin : undefined;
}

function resolvePnpmCommand() {
  if (!withRemoteAssets) {
    return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  }

  const userPnpmBin = resolveUserPnpmBin();
  if (userPnpmBin) {
    return join(userPnpmBin, process.platform === "win32" ? "pnpm.cmd" : "pnpm");
  }

  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}

function resolveBootstrapWithRemoteEnv(baseEnv = process.env) {
  if (!withRemoteAssets) {
    return {};
  }

  const pathEntries = [resolvePinnedNodeBin(), resolveUserPnpmBin()].filter(Boolean);

  return {
    // bootstrap:with-remote 是手动远程资源初始化入口，自动化等非 TTY 环境里
    // pnpm install 可能要求确认清理 node_modules。只在该入口禁用确认，不改变 CI/生产构建命令。
    HUSKY: "0",
    PNPM_CONFIG_CONFIRM_MODULES_PURGE: "false",
    npm_config_confirm_modules_purge: "false",
    // remote assets 和 bootstrap build 同一轮里会触发大量 workspace 构建。
    // 这里把降峰值限制在 bootstrap:with-remote 子进程，不修改 build/build:bootstrap 的全局语义。
    PNPM_CONFIG_WORKSPACE_CONCURRENCY: "1",
    ZCODE_BOOTSTRAP_WITH_REMOTE: "1",
    ...(pathEntries.length > 0
      ? {
          PATH: prependPathEntries(baseEnv.PATH, pathEntries),
        }
      : {}),
  };
}

const bootstrapWithRemoteEnv = resolveBootstrapWithRemoteEnv();
const pnpmCommand = resolvePnpmCommand();

function runGit(args) {
  runCommand(gitCommand, args, {
    cwd: rootDir,
    env: process.env,
  });
}

function runPnpm(args, options = {}) {
  runCommand(pnpmCommand, args, {
    cwd: rootDir,
    env: {
      ...process.env,
      ...bootstrapWithRemoteEnv,
      ...options.env,
    },
  });
}

function runBootstrapServerBuild() {
  const serverDir = resolve(rootDir, "packages/server");

  // bootstrap:with-remote 的最终构建过去复用 build:bootstrap，导致 @zcode/server build
  // 内部再次嵌套 pnpm run build:remote；在本地低内存环境中 tsx/esbuild 子进程容易卡住或被停掉。
  // 同时不能按 dist 文件存在就跳过构建：开发时 version 经常不变，旧 entry-http 或 remote bundle
  // 会让本地/远端继续运行旧协议。这里仅保留直接执行等价入口的低内存优化，CI 和生产 build 脚本保持原样。
  runCommand(process.execPath, [resolve(rootDir, "node_modules/tsup/dist/cli-default.js")], {
    cwd: serverDir,
    env: {
      ...process.env,
      ...bootstrapWithRemoteEnv,
    },
  });
  runCommand(
    process.execPath,
    [resolve(rootDir, "node_modules/tsx/dist/cli.mjs"), "build-remote.ts"],
    {
      cwd: serverDir,
      env: {
        ...process.env,
        ...bootstrapWithRemoteEnv,
      },
    },
  );
}

function runBootstrapE2eReportBuild() {
  const e2eReportDir = resolve(rootDir, "packages/e2e-report");
  // Bugfix: bootstrap:with-remote 的最终构建不能再嵌套 pnpm build:node。
  // 低内存环境中 pnpm shim + tsc 会被 SIGKILL；这里只在 bootstrap runner 中直接执行等价入口。
  runCommand(
    process.execPath,
    [resolve(rootDir, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json"],
    {
      cwd: e2eReportDir,
      env: {
        ...process.env,
        ...bootstrapWithRemoteEnv,
      },
    },
  );
  runCommand(process.execPath, [resolve(rootDir, "node_modules/vite/bin/vite.js"), "build"], {
    cwd: e2eReportDir,
    env: {
      ...process.env,
      ...bootstrapWithRemoteEnv,
    },
  });
}

function runBootstrapStreamAnimateBuild() {
  const streamAnimateDir = resolve(rootDir, "packages/stream-animate");
  // Bugfix: bootstrap:with-remote 串行最终构建时，继续通过 pnpm 执行 stream-animate 的 tsc
  // 仍可能命中 shim 被 SIGKILL；这里仅在 bootstrap runner 中直接执行等价入口。
  runCommand(
    process.execPath,
    [resolve(rootDir, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.server.json"],
    {
      cwd: streamAnimateDir,
      env: {
        ...process.env,
        ...bootstrapWithRemoteEnv,
      },
    },
  );
  runCommand(process.execPath, [resolve(rootDir, "node_modules/vite/bin/vite.js"), "build"], {
    cwd: streamAnimateDir,
    env: {
      ...process.env,
      ...bootstrapWithRemoteEnv,
    },
  });
}

function runBootstrapDesktopBuild() {
  const desktopDir = resolve(rootDir, "packages/desktop");
  // bootstrap:with-remote 的目标是完成远程资源和本地 runtime 初始化。
  // 继续触发 desktop app bundle 会进入生产构建脚本里的 tsup/vite 路径，在本地低内存环境中被 SIGKILL。
  // 这里仅在 bootstrap runner 中保留 build meta，生产/CI 的 build:no-runtime-assets 仍保持原语义。
  runCommand(process.execPath, ["scripts/build-metadata.mjs"], {
    cwd: desktopDir,
    env: {
      ...process.env,
      ...bootstrapWithRemoteEnv,
    },
  });
  console.log("[bootstrap:with-remote] skip desktop app bundle build; runtime assets are prepared");
}

function runBootstrapWithRemoteBuild() {
  for (const filter of ["@zcode/rpc", "@zcode/web", "@zcode/formal-proof"]) {
    // pnpm -r 会在 bootstrap:with-remote 的最终构建阶段并发启动多个 Vite/esbuild/tsup。
    // remote assets 已经占过一轮内存峰值，这里显式串行包构建，且不改变 build:bootstrap/CI 命令。
    runPnpm(["--filter", filter, "build"]);
  }
  runBootstrapE2eReportBuild();
  runBootstrapStreamAnimateBuild();
  runBootstrapServerBuild();
  runBootstrapDesktopBuild();
}

runGit(["submodule", "update", "--init", "--recursive", "apps/zcode-cli"]);

runPnpm(withRemoteAssets ? ["install", "--config.confirmModulesPurge=false"] : ["install"]);

runPnpm(["prepare:desktop-runtime"], {
  env: withRemoteAssets
    ? {}
    : {
        // 本地 bootstrap 过去默认准备 remote mock-cdn，
        // 每次都会重新打包跨平台组件，导致普通初始化很慢。
        // 默认只准备桌面端本地 runtime；需要远程资源时使用 bootstrap:with-remote。
        ZCODE_SKIP_REMOTE_ASSETS: "1",
      },
});

if (withRemoteAssets) {
  runBootstrapWithRemoteBuild();
} else {
  runPnpm(["run", "build:bootstrap"]);
}
