#!/usr/bin/env node
/**
 * R3 Docker Transport 验证：在真实 Linux 容器内安装 staged Source Server，启动 Core，
 * 再通过正式 `zcode server proxy-stdio` 的 stdin/stdout 访问受鉴权的 ingress。
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
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
const archive = join(packageRoot, "dist-release", `zcode-server-${target}.tar.gz`);
const containerName = `zcode-proxy-stdio-${process.pid}`;
const image = process.env.ZCODE_PROXY_STDIO_IMAGE ?? "node:24-bookworm-slim";

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

function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

let exitCode = 0;
try {
  await run("docker", ["version"]);
  await run("docker", ["run", "--detach", "--name", containerName, image, "sleep", "infinity"]);
  await run("docker", ["cp", archive, `${containerName}:/tmp/zcode-server.tar.gz`]);
  await run("docker", [
    "exec",
    containerName,
    "sh",
    "-lc",
    [
      "mkdir -p /tmp/zcode-bootstrap",
      "tar -xzf /tmp/zcode-server.tar.gz -C /tmp/zcode-bootstrap --strip-components=1",
      "/tmp/zcode-bootstrap/bin/zcode update --from-archive /tmp/zcode-server.tar.gz --server-root /root/.zcode/server --json",
      "ZCODE_SERVER_SKIP_SERVICE_REGISTRATION=1 /root/.zcode/server/bin/zcode serve --daemon --server-root /root/.zcode/server --json",
    ].join(" && "),
  ]);
  const statusResult = await run("docker", [
    "exec",
    containerName,
    "/root/.zcode/server/bin/zcode",
    "status",
    "--server-root",
    "/root/.zcode/server",
    "--json",
  ]);
  const status = JSON.parse(statusResult.stdout.toString("utf8").trim().split("\n").pop());
  assert(status.state === "ready", `Source Server ready, got ${status.state}`);
  const tokenResult = await run("docker", [
    "exec",
    containerName,
    "cat",
    "/root/.zcode/server/run/ingress-token",
  ]);
  const token = tokenResult.stdout.toString("utf8").trim();
  assert(token.length >= 32, "ingress token exists");

  // Docker exec -i 是正式 proxy-stdio 的底层字节桥；HTTP 200 只能证明文本请求成功，
  // 不能替代 NUL/高位字节/大 chunk 的无损守护。保留独立 64 KiB round-trip 断言。
  const binaryPayload = Buffer.concat([
    Buffer.from([0, 1, 2, 13, 10, 127, 128, 254, 255]),
    randomBytes(64 * 1024),
  ]);
  const binaryRoundTrip = await run("docker", ["exec", "-i", containerName, "sh", "-lc", "cat"], {
    input: binaryPayload,
  });
  assert(binaryRoundTrip.stdout.equals(binaryPayload), "docker exec preserves 64 KiB binary data");
  assert(binaryRoundTrip.stderr.length === 0, "docker exec binary bridge keeps stderr empty");

  const request = Buffer.from(
    `GET /api/server-info HTTP/1.1\r\nHost: source-server\r\nAuthorization: Bearer ${token}\r\nConnection: close\r\n\r\n`,
    "utf8",
  );
  const response = await run(
    "docker",
    [
      "exec",
      "-i",
      containerName,
      "/root/.zcode/server/bin/zcode",
      "server",
      "proxy-stdio",
      "--server-root",
      "/root/.zcode/server",
    ],
    { input: request },
  );
  const rawResponse = response.stdout.toString("utf8");
  assert(
    rawResponse.startsWith("HTTP/1.1 200"),
    `proxy response is HTTP 200: ${rawResponse.slice(0, 80)}`,
  );
  assert(rawResponse.includes('"serverId"'), "proxy response contains server-info JSON");
  console.log(
    `[verify-proxy-stdio-docker] PASS target=${target} httpBytes=${response.stdout.length} binaryBytes=${binaryPayload.length}`,
  );
} catch (error) {
  exitCode = 1;
  console.error(
    "[verify-proxy-stdio-docker] FAILED:",
    error instanceof Error ? error.message : error,
  );
} finally {
  await run("docker", ["rm", "-f", containerName], { allowFailure: true }).catch(() => undefined);
}
process.exit(exitCode);
