import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { isRealComputerUseProducerInstalled } from "../packages/desktop/scripts/computer-use-producer.mjs";
import { resolveDevDesktopWindowsCuaEnv } from "./dev-desktop-cua-env.mjs";
import { withPinnedNodePath } from "./mise-toolchain-env.mjs";
import { quoteArgsForWindowsShell } from "./spawn-command.mjs";

const requestedEnv = process.argv[2]?.trim().toLowerCase();
const agentBytecode = process.argv.slice(3).includes("--agent-bytecode");
if (requestedEnv !== "test" && requestedEnv !== "production") {
  console.error("Usage: node scripts/dev-desktop-env.mjs <test|production> [--agent-bytecode]");
  process.exit(1);
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
// Computer Use Helper 只由真实 producer 提供；开源占位包下不构建 Helper、不注入 Helper 环境。
// 见 docs/desktop/computer-use-producer-detection.md。
const hasComputerUseProducer = isRealComputerUseProducerInstalled({
  desktopPackageRoot: join(repoRoot, "packages", "desktop"),
});
const computerUseDevEnv = hasComputerUseProducer ? await resolveComputerUseDevEnv() : {};

async function resolveComputerUseDevEnv() {
  const { DEV_HELPER_APP_NAME } = await import("@zcode/zcode-cua/broker/helperConstants");
  const sourceBuiltCuaHelperVersion = JSON.parse(
    readFileSync(join(repoRoot, "package.json"), "utf8"),
  ).version;
  if (typeof sourceBuiltCuaHelperVersion !== "string" || !sourceBuiltCuaHelperVersion.trim()) {
    throw new Error("Root package.json must define the Dev Computer Use Helper version");
  }
  const sourceBuiltCuaHelperApp = join(
    repoRoot,
    "packages",
    "desktop",
    "dist-cua-helper",
    DEV_HELPER_APP_NAME,
  );
  return {
    // Standard dev launch must test the Helper built from this checkout.
    // Falling back to ~/.zcode can silently reuse a same-version stale
    // Helper and make native changes appear verified when they never ran.
    ZCODE_CUA_BUNDLED_HELPER_APP_PATH: sourceBuiltCuaHelperApp,
    ZCODE_CUA_HELPER_VERSION: sourceBuiltCuaHelperVersion,
    // Keep Dev Desktop separate from signed Stable/Preview and standalone MCP installs.
    ZCODE_CUA_HELPER_INSTALL_VARIANT: "dev-desktop",
    // 修复原因：仅传 bundled path 不会进入 unsigned-local 的同版本内容刷新分支，
    // 导致标准 dev 启动继续复用 ~/.zcode 中 native ABI 已过期的 Helper。
    ...(process.platform === "darwin" ? { ZCODE_CUA_HELPER_ALLOW_UNSIGNED_LOCAL: "1" } : {}),
    // Windows 侧对应物：缺省把 CUA runtime 绑到本 checkout 已安装的 producer，
    // 否则 host 会去读 dev 下不存在的 resources/tools/cua-helper。见 dev-desktop-cua-env.mjs。
    ...resolveDevDesktopWindowsCuaEnv({
      platform: process.platform,
      repoRoot,
      env: process.env,
    }),
  };
}

function run(command, args) {
  return new Promise((resolveRun, rejectRun) => {
    // Windows 下 shell:true 只按空格拼接参数；仓库路径含空格（如 E:\Z Code\...）时
    // node <script> 的脚本路径会被 cmd 截断成 E:\Z 并报 Cannot find module，因此先补引号。
    const spawnArgs = process.platform === "win32" ? quoteArgsForWindowsShell(args) : args;
    const child = spawn(command, spawnArgs, {
      cwd: repoRoot,
      env: withPinnedNodePath(
        {
          ...process.env,
          ZCODE_ENV: requestedEnv,
          ZCODE_DESKTOP_AGENT_BYTECODE: agentBytecode ? "1" : "0",
          ...computerUseDevEnv,
        },
        process.execPath,
      ),
      stdio: "inherit",
      // Windows .cmd/.bat executables (pnpm.cmd, npm.cmd, etc.) require shell: true
      shell: process.platform === "win32",
    });

    child.on("error", rejectRun);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolveRun();
        return;
      }
      rejectRun(
        new Error(
          signal
            ? `${command} exited with signal ${signal}`
            : `${command} exited with code ${code ?? "unknown"}`,
        ),
      );
    });
  });
}

try {
  if (process.platform === "darwin" && hasComputerUseProducer) {
    await run(process.execPath, [
      resolve(repoRoot, "scripts/build-cua-helper-app.mjs"),
      "--allow-unsigned-launcher-local-dev",
    ]);
  }
  // The public dev scripts delegate here instead of invoking the package's
  // `dev` lifecycle directly, so pnpm will not run `pre-dev` automatically.
  // Preserve its runtime-asset preparation and stale `out` cleanup explicitly
  // before rebuilding bundles or starting Electron.
  await run(pnpmCommand, ["--filter", "@zcode/desktop", "pre-dev"]);
  // On Windows, use "node" (resolved via PATHEXT) to avoid "C:\Program Files\..." space issues
  await run(process.platform === "win32" ? "node" : process.execPath, [
    resolve(repoRoot, "scripts/build-desktop-agent-cli.mjs"),
  ]);
  if (agentBytecode) {
    await run(process.platform === "win32" ? "node" : process.execPath, [
      resolve(repoRoot, "scripts/build-desktop-agent-bytecode.mjs"),
    ]);
  }
  await run(pnpmCommand, ["--filter", "@zcode/desktop", "dev:runtime"]);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
