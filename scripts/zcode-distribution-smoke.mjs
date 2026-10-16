// 在仓库外验证发行包，避免开发机 node_modules 掩盖缺失的 TUI/native/worker 依赖。
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { promisify, stripVTControlCharacters } from "node:util";
import { pathToFileURL } from "node:url";

const exec = promisify(execFile);
const archive = process.argv[2];
assert.ok(archive, "Usage: node scripts/zcode-distribution-smoke.mjs <archive.tar.gz>");
const directory = await realpath(await mkdtemp(join(tmpdir(), "zcode-release-smoke-")));
const root = join(directory, "zcode");
const runner = join(root, "bin/zcode.mjs");
const workspace = join(directory, "workspace");
const env = {
  ...process.env,
  ZCODE_DATA_BASE_DIR: join(directory, "data"),
  NODE_PATH: "",
  NODE_OPTIONS: "",
  TERM: "xterm-256color",
};
let web;
let terminal;
try {
  await exec("tar", ["-xzf", resolve(archive), "-C", directory]);
  await mkdir(workspace);
  await exec(process.execPath, [runner, "--help"], { cwd: workspace, env });
  const version = (
    await exec(process.execPath, [runner, "--version"], { cwd: workspace, env })
  ).stdout.trim();
  const require = createRequire(join(root, "package.json"));
  const pty = require("node-pty");
  const runtimeCheck = join(root, "agent/check-tui.mjs");
  await writeFile(
    runtimeCheck,
    'import { runTui } from "@zcode/tui"; if (typeof runTui !== "function") throw new Error("Missing TUI export"); console.log("tui-runtime-ok");',
  );
  const imported = await exec(process.execPath, [runtimeCheck], { cwd: workspace, env });
  assert.match(imported.stdout, /tui-runtime-ok/);

  terminal = pty.spawn(process.execPath, [runner], { cwd: workspace, env, cols: 110, rows: 32 });
  let screen = "";
  let terminalExit;
  terminal.onData((data) => {
    screen += data;
  });
  const tuiExited = new Promise((done) =>
    terminal.onExit((event) => {
      terminalExit = event;
      done(event);
    }),
  );
  await until(
    () => {
      // 修复：TUI 渲染器会在相邻字符之间插入 SGR/光标定位序列，原始 PTY 输出里的提示词不连续；
      // 先去掉终端控制序列再匹配可见文本，避免界面已就绪却被判定为超时。
      const visible = stripVTControlCharacters(screen);
      return /ZCode/.test(visible) && /(?:登录|\/login|输入提示词|Type a prompt)/i.test(visible);
    },
    "TUI initialized render",
    () => stripVTControlCharacters(screen),
  );
  assert.equal(terminalExit, undefined, screen);
  assert.doesNotMatch(screen, /Cannot find (?:module|package)|ERR_MODULE_NOT_FOUND/);
  // 保留真实键盘退出链路；不发送 prompt，不调用模型。
  terminal.write("\u0003");
  await setTimeout(200);
  if (!terminalExit) terminal.write("\u0003");
  const tuiExit = await Promise.race([
    tuiExited,
    setTimeout(8000).then(() => {
      throw new Error("TUI keyboard exit timed out");
    }),
  ]);
  assert.equal(tuiExit.exitCode, 0, screen);
  terminal = undefined;

  let webOutput = "";
  web = spawn(process.execPath, [runner, "--web", "--workspace", workspace, "--no-open"], {
    cwd: workspace,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  web.stdout.on("data", (data) => {
    webOutput += data;
  });
  web.stderr.on("data", (data) => {
    webOutput += data;
  });
  let base;
  await until(
    () => {
      base = webOutput.match(/Local:\s+(http:\/\/127\.0\.0\.1:\d+\/)/)?.[1];
      return Boolean(base);
    },
    "Web URL",
    () => webOutput,
  );
  let info;
  await until(
    async () => {
      try {
        const response = await fetch(new URL("api/server-info", base), {
          signal: AbortSignal.timeout(1000),
        });
        if (!response.ok) return false;
        info = await response.json();
        return true;
      } catch {
        return false;
      }
    },
    "Web readiness",
    () => webOutput,
  );
  assert.equal(info.workspaces[0].path, workspace);
  const html = await fetch(base);
  assert.equal(html.status, 200);
  assert.match(await html.text(), /<html/i);
  const { default: WebSocket } = await import(pathToFileURL(require.resolve("ws")).href);
  const socket = new WebSocket(new URL("ws", base.replace("http:", "ws:")));
  await once(socket, "open");
  socket.close();
  await once(socket, "close");
  const exited = once(web, "exit");
  web.kill("SIGTERM");
  assert.deepEqual(await exited, [0, null]);
  web = undefined;
  console.log(
    JSON.stringify({
      version,
      platform: process.platform,
      arch: process.arch,
      tui: "native import, initialized render, keyboard exit passed",
      web: "HTML, server-info, workspace, WebSocket, shutdown passed",
      isolated: true,
    }),
  );
} finally {
  terminal?.kill();
  web?.kill();
  await rm(directory, { recursive: true, force: true });
}

async function until(check, label, diagnostic) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await setTimeout(100);
  }
  throw new Error(`${label} timed out:\n${diagnostic()}`);
}
