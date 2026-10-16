#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { connect as connectTcp, createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = resolve(import.meta.dirname, "..");
const startScript = join(repoRoot, "docker/web-app/start.mjs");

const tempDir = await mkdtemp(join(tmpdir(), "zcode-web-app-gateway-reset-"));
const dataDir = join(tempDir, "data");
const workspaceDir = join(tempDir, "workspace");
const webDistDir = join(tempDir, "web");
const backendEntry = join(tempDir, "backend.mjs");
const agentEntry = join(tempDir, "agent.cjs");
const injectResetEntry = join(tempDir, "inject-reset.mjs");
const publicPort = await reservePort();
const backendPort = await reservePort();

let child;
try {
  await mkdir(dataDir, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });
  await mkdir(webDistDir, { recursive: true });
  await writeFile(join(webDistDir, "index.html"), "<!doctype html><html><body>ZCode test</body></html>\n");
  await writeFile(agentEntry, "module.exports = {};\n");
  await writeFile(
    injectResetEntry,
    `setTimeout(() => {
  process.emit("uncaughtException", Object.assign(new Error("read ECONNRESET"), {
    code: "ECONNRESET",
    syscall: "read",
  }));
}, 250);
`,
  );
  await writeFile(
    backendEntry,
    `import { createServer } from "node:http";

const startDelayMs = Number(process.env.ZCODE_TEST_BACKEND_START_DELAY_MS || 0);

setTimeout(() => {
  const server = createServer((req, res) => {
    if (req.url === "/api/stream") {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      const payload = Buffer.alloc(64 * 1024, "x");
      const timer = setInterval(() => {
        res.write(payload);
      }, 5);
      res.on("close", () => clearInterval(timer));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });

  server.on("upgrade", (_req, socket) => {
    socket.write("HTTP/1.1 101 Switching Protocols\\r\\nConnection: Upgrade\\r\\nUpgrade: websocket\\r\\n\\r\\n");
  });

  server.listen(Number(process.env.PORT), "127.0.0.1");
}, startDelayMs);
`,
  );

  child = spawn(process.execPath, [startScript], {
    cwd: repoRoot,
    env: {
      ...process.env,
      NODE_OPTIONS: appendNodeImport(process.env.NODE_OPTIONS, injectResetEntry),
      PORT: String(publicPort),
      ZCODE_BACKEND_PORT: String(backendPort),
      ZCODE_DATA_BASE_DIR: dataDir,
      ZCODE_SERVER_ENTRY: backendEntry,
      ZCODE_AGENT_ENTRY: agentEntry,
      ZCODE_SERVER_WORKSPACE: workspaceDir,
      ZCODE_STORAGE_DIR: join(dataDir, ".zcode"),
      ZCODE_TEST_BACKEND_START_DELAY_MS: "1000",
      ZCODE_WEB_DIST_DIR: webDistDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const output = [];
  child.stdout.on("data", (chunk) => output.push(String(chunk)));
  child.stderr.on("data", (chunk) => output.push(String(chunk)));

  await waitForOutput(output, "listening on", 5_000);
  await assertHealthzStatus(publicPort, 503);
  await waitForHealthzStatus(publicPort, 200, 5_000);
  await delay(500);
  await resetHttpStream(publicPort);
  await resetUpgradeConnection(publicPort);
  await delay(1_000);

  if (child.exitCode !== null) {
    throw new Error(`gateway exited after client disconnects:\n${output.join("")}`);
  }

  await assertHealthzStatus(publicPort, 200);
  console.log("web app gateway tolerates reset client connections");
} finally {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await waitForExit(child, 5_000).catch(() => child.kill("SIGKILL"));
  }
  await rm(tempDir, { force: true, recursive: true });
}

async function reservePort() {
  const server = createTcpServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : null;
  await new Promise((resolveClose) => server.close(resolveClose));
  if (!port) {
    throw new Error("failed to reserve port");
  }
  return port;
}

async function waitForOutput(output, text, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (output.join("").includes(text)) {
      return;
    }
    await delay(25);
  }
  throw new Error(`timed out waiting for ${text}:\n${output.join("")}`);
}

async function resetHttpStream(port) {
  await new Promise((resolveAbort) => {
    const req = httpRequest({ hostname: "127.0.0.1", path: "/api/stream", port }, (res) => {
      res.resume();
      res.once("data", () => {
        resetSocket(req.socket);
        resolveAbort();
      });
      res.on("end", resolveAbort);
    });
    req.on("error", () => resolveAbort());
    req.end();
  });
}

async function resetUpgradeConnection(port) {
  await new Promise((resolveReset, rejectReset) => {
    const socket = connectTcp(port, "127.0.0.1");
    const timer = setTimeout(() => {
      socket.destroy();
      rejectReset(new Error("upgrade reset timed out"));
    }, 1_000);

    socket.once("error", () => {
      clearTimeout(timer);
      resolveReset();
    });
    socket.once("connect", () => {
      socket.write(
        "GET /ws HTTP/1.1\r\n" +
          "Host: 127.0.0.1\r\n" +
          "Connection: Upgrade\r\n" +
          "Upgrade: websocket\r\n" +
          "Sec-WebSocket-Version: 13\r\n" +
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
          "\r\n",
      );
      setTimeout(() => {
        resetSocket(socket);
        clearTimeout(timer);
        resolveReset();
      }, 20);
    });
  });
}

async function waitForHealthzStatus(port, expectedStatus, timeoutMs) {
  const start = Date.now();
  let lastResult;
  while (Date.now() - start < timeoutMs) {
    lastResult = await requestHealthz(port).catch((error) => ({ error: error.message }));
    if (lastResult.statusCode === expectedStatus) {
      return;
    }
    await delay(25);
  }
  throw new Error(`timed out waiting for healthz ${expectedStatus}: ${JSON.stringify(lastResult)}`);
}

async function assertHealthzStatus(port, expectedStatus) {
  const result = await requestHealthz(port);
  if (result.statusCode !== expectedStatus) {
    throw new Error(`healthz returned ${result.statusCode}, expected ${expectedStatus}: ${result.body}`);
  }
  if (expectedStatus === 200 && !result.body.includes('"ok":true')) {
    throw new Error(`unexpected healthz body: ${result.body}`);
  }
  if (expectedStatus !== 200 && !result.body.includes('"ok":false')) {
    throw new Error(`unexpected non-ready healthz body: ${result.body}`);
  }
}

async function requestHealthz(port) {
  return new Promise((resolveBody, rejectBody) => {
    const req = httpRequest({ hostname: "127.0.0.1", path: "/healthz", port }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        resolveBody({ body: data, statusCode: res.statusCode });
      });
    });
    req.on("error", rejectBody);
    req.end();
  });
}

async function waitForExit(childProcess, timeoutMs) {
  if (childProcess.exitCode !== null) {
    return;
  }
  await new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => {
      childProcess.off("exit", onExit);
      rejectExit(new Error("timed out waiting for child exit"));
    }, timeoutMs);
    function onExit() {
      clearTimeout(timer);
      resolveExit();
    }
    childProcess.once("exit", onExit);
  });
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function resetSocket(socket) {
  if (!socket) {
    return;
  }
  if (typeof socket.resetAndDestroy === "function") {
    socket.resetAndDestroy();
    return;
  }
  socket.destroy(Object.assign(new Error("client reset"), { code: "ECONNRESET" }));
}

function appendNodeImport(existingOptions, importPath) {
  const importOption = `--import=${pathToFileURL(importPath).href}`;
  return existingOptions?.trim() ? `${existingOptions} ${importOption}` : importOption;
}
