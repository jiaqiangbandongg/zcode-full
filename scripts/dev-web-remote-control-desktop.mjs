#!/usr/bin/env node
import { spawn } from "node:child_process";
import process from "node:process";

const DEFAULT_WEB_REMOTE_CONTROL_URL = "http://localhost:5173/remote";

const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const webRemoteControlUrl =
  process.env.ZCODE_WEB_REMOTE_CONTROL_URL?.trim() || DEFAULT_WEB_REMOTE_CONTROL_URL;

console.log(
  `[dev:web-remote-control] desktop ZCODE_WEB_REMOTE_CONTROL_URL=${webRemoteControlUrl}`,
);

const child = spawn(pnpmCommand, ["--filter", "@zcode/desktop", "dev:local-cli"], {
  stdio: "inherit",
  env: {
    ...process.env,
    ZCODE_WEB_REMOTE_CONTROL_URL: webRemoteControlUrl,
  },
});

let signalForwarded = false;
const forwardSignal = (signal) => {
  if (signalForwarded) {
    return;
  }
  signalForwarded = true;
  child.kill(signal);
};

process.on("SIGINT", () => forwardSignal("SIGINT"));
process.on("SIGTERM", () => forwardSignal("SIGTERM"));

child.on("error", (error) => {
  console.error("[dev:web-remote-control] failed to start desktop dev process", error);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.exit(1);
  }
  process.exit(code ?? 0);
});
