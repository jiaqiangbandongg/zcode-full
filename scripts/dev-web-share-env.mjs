import { spawn } from "node:child_process";

const TEST_SHARE_ENDPOINT_ORIGIN = "https://zcode.z.ai";

const mode = process.argv[2]?.trim().toLowerCase();
if (mode !== "test" && mode !== "mock") {
  console.error("Usage: node scripts/dev-web-share-env.mjs <test|mock>");
  process.exit(1);
}

const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const env = {
  ...process.env,
  ZCODE_ENV: "test",
  VITE_ZCODE_BASE_URL: TEST_SHARE_ENDPOINT_ORIGIN,
  VITE_DEV_ORIGIN: "http://localhost:5173",
  VITE_CONVERSATION_SHARE_PREVIEW_MOCK: mode === "mock" ? "true" : "false",
};
const args = [
  "--filter",
  "@zcode/web-share",
  "exec",
  "vite",
  "dev",
  "--strictPort",
  "--host",
  "127.0.0.1",
  // 分享页同时支持 /cn/share/<code>（中文）与 /share/<code>（英文）。
  // 之前这里写死 --base=/cn/share/，Vite 就只服务该前缀，访问 /share/<code> 会被
  // dev server 直接拒掉（"server is configured with a public base URL of /cn/share/"），
  // 英文路由在本地根本没法验。base 用 / 让两个前缀都能落到 SPA。
  //
  // 注意生产构建（package.json 的 build:web-share）仍是 --base=/cn/share/：那决定的是
  // 静态资源的绝对路径，要不要改取决于站点怎么托管，不能只看本地。
  "--base=/",
];
if (mode === "mock") {
  args.push("--open", "/cn/share/mock-importable");
}

console.info(
  `[dev:web-share] mode=${mode} endpoint=${TEST_SHARE_ENDPOINT_ORIGIN} ` +
    "share code is read from /cn/share/<code> (zh) or /share/<code> (en)",
);

const child = spawn(pnpmCommand, args, {
  cwd: process.cwd(),
  env,
  stdio: "inherit",
  shell: process.platform === "win32",
});

const forwardSignal = (signal) => child.kill(signal);
process.on("SIGINT", () => forwardSignal("SIGINT"));
process.on("SIGTERM", () => forwardSignal("SIGTERM"));
child.on("error", (error) => {
  console.error("[dev:web-share] failed to start Vite", error);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
