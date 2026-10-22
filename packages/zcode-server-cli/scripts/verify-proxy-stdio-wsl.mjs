#!/usr/bin/env node
/**
 * R3 WSL Transport smoke：在真实 WSL 中从 archive 安装 Source Server，启动 daemon，
 * 并通过正式 proxy-stdio 验证鉴权 HTTP 与 64 KiB WSL stdio 字节桥。
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveVerificationTarget } from "./verify-remote-ssh-target.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const readArg = (flag) => {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
};
const target = resolveVerificationTarget(readArg("--target"));
const distro = readArg("--distro");
const archive = join(packageRoot, "dist-release", `zcode-server-${target}.tar.gz`);
const operationId = `zcode-wsl-verify-${process.pid}`;
const archivePath = `/tmp/${operationId}.tar.gz`;
const bootstrapDir = `/tmp/${operationId}-bootstrap`;
const serverRoot = `/tmp/${operationId}-server`;
const wslBaseArgs = [...(distro ? ["--distribution", distro] : []), "--"];

function run(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      stdio: [options.input ? "pipe" : "ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    if (options.input) child.stdin.end(options.input);
    child.once("error", rejectPromise);
    child.once("exit", (code) => {
      const result = {
        code: code ?? 1,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      };
      if (result.code === 0 || options.allowFailure) resolvePromise(result);
      else
        rejectPromise(
          new Error(`${command} ${args.join(" ")} failed: ${result.stderr.toString("utf8")}`),
        );
    });
  });
}

const wsl = (args, options) => run("wsl.exe", [...wslBaseArgs, ...args], options);
const shell = (script, options) => wsl(["sh", "-lc", script], options);

function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

let exitCode = 0;
try {
  await wsl(["true"]);
  await shell(
    `rm -rf '${bootstrapDir}' '${serverRoot}' '${archivePath}' && cat > '${archivePath}'`,
    {
      input: await readFile(archive),
    },
  );
  await shell(
    [
      `mkdir -p '${bootstrapDir}'`,
      `tar -xzf '${archivePath}' -C '${bootstrapDir}' --strip-components=1`,
      `'${bootstrapDir}/bin/zcode' update --from-archive '${archivePath}' --server-root '${serverRoot}' --json`,
      `ZCODE_SERVER_SKIP_SERVICE_REGISTRATION=1 '${serverRoot}/bin/zcode' serve --daemon --server-root '${serverRoot}' --json`,
    ].join(" && "),
  );
  const statusResult = await wsl([
    `${serverRoot}/bin/zcode`,
    "status",
    "--server-root",
    serverRoot,
    "--json",
  ]);
  const status = JSON.parse(statusResult.stdout.toString("utf8").trim().split("\n").pop());
  assert(status.state === "ready", `Source Server ready, got ${status.state}`);
  const token = (await shell(`cat '${serverRoot}/run/ingress-token'`)).stdout
    .toString("utf8")
    .trim();
  assert(token.length >= 32, "ingress token exists");

  const binaryPayload = Buffer.concat([
    Buffer.from([0, 1, 2, 13, 10, 127, 128, 254, 255]),
    randomBytes(64 * 1024),
  ]);
  const binaryRoundTrip = await shell("cat", { input: binaryPayload });
  assert(binaryRoundTrip.stdout.equals(binaryPayload), "WSL stdio preserves 64 KiB binary data");

  const request = Buffer.from(
    `GET /api/server-info HTTP/1.1\r\nHost: source-server\r\nAuthorization: Bearer ${token}\r\nConnection: close\r\n\r\n`,
    "utf8",
  );
  const response = await wsl(
    [`${serverRoot}/bin/zcode`, "server", "proxy-stdio", "--server-root", serverRoot],
    { input: request },
  );
  const rawResponse = response.stdout.toString("utf8");
  assert(rawResponse.startsWith("HTTP/1.1 200"), "proxy response is HTTP 200");
  assert(rawResponse.includes('"serverId"'), "proxy response contains server-info JSON");
  console.log(
    `[verify-proxy-stdio-wsl] PASS target=${target} httpBytes=${response.stdout.length} binaryBytes=${binaryPayload.length}`,
  );
} catch (error) {
  exitCode = 1;
  console.error("[verify-proxy-stdio-wsl] FAILED:", error instanceof Error ? error.message : error);
} finally {
  await shell(
    `'${serverRoot}/bin/zcode' stop --server-root '${serverRoot}' --json >/dev/null 2>&1 || true; rm -rf '${bootstrapDir}' '${serverRoot}' '${archivePath}'`,
    { allowFailure: true },
  ).catch(() => undefined);
}
process.exit(exitCode);
