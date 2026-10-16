import { verifySamplingDatabase } from "./mcp-apps-host-fixture/sampling-database.mjs";
import { build } from "esbuild";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
const require = createRequire(import.meta.url);
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(desktop, "../..");
const output = await mkdtemp(join(tmpdir(), "zcode-mcp-host-e2e-"));
const fixture = join(desktop, "scripts/mcp-apps-host-fixture");
const showcaseServer = process.env.ZCODE_SHOWCASE_SERVER;
if (process.argv.includes("--showcase-only")) {
  if (!showcaseServer)
    throw new Error(
      "Set ZCODE_SHOWCASE_SERVER to the built Showcase dist/server.mjs from zcode-plugins",
    );
  await access(showcaseServer);
}
const sentinel = new DatabaseSync(join(output, "plugin-sentinel.sqlite"));
sentinel.exec(
  "CREATE TABLE fixture(value TEXT); INSERT INTO fixture VALUES ('preserve-plugin-data')",
);
sentinel.close();
await writeFile(join(output, "plugin-sentinel.txt"), "preserve-plugin-files\n");
// Agent bundle 必须来自本次源码；否则 Electron 用新代码、stdio 却测到旧 dist。
if (
  !process.argv.includes("--retention-only") &&
  !process.argv.includes("--storage-only") &&
  !process.argv.includes("--reuse-agent-build")
) {
  // 新工作树没有预先生成的声明文件，先构建 Agent 的基础包。
  for (const name of [
    "shared-types",
    "dynamic-workflow",
    "contracts",
    "i18n",
    "telemetry",
    "dynamic-workflow-runtime",
    "core",
    "adapters",
    "bootstrap",
    "cli",
  ]) {
    await new Promise((accept, reject) => {
      const child = spawn(
        "pnpm",
        [
          "--dir",
          join(root, "apps/zcode-cli"),
          "--filter",
          `@zcode/${name}`,
          name === "cli" ? "build:desktop-agent" : "build",
        ],
        { stdio: "inherit" },
      );
      child.on("error", reject);
      child.on("exit", (code) =>
        code === 0 ? accept() : reject(new Error(`Agent fixture build failed: ${name} (${code})`)),
      );
    });
  }
}
const shared = join(root, "packages/shared/src");
const sharedExports = JSON.parse(await readFile(join(shared, "../package.json"), "utf8")).exports;
const alias = {
  "@": join(root, "packages/ui/src"),
  ...Object.fromEntries(
    Object.entries(sharedExports).map(([key, value]) => [
      key === "." ? "@zcode/shared" : `@zcode/shared/${key.slice(2)}`,
      resolve(shared, "..", value),
    ]),
  ),
  "@modelcontextprotocol/ext-apps": require.resolve("@modelcontextprotocol/ext-apps", {
    paths: [join(root, "packages/ui")],
  }),
  "@modelcontextprotocol/ext-apps/app-bridge": require.resolve(
    "@modelcontextprotocol/ext-apps/app-bridge",
    { paths: [join(root, "packages/ui")] },
  ),
};
const bundle = (entry, file, platform = "browser") =>
  build({
    entryPoints: [entry],
    outfile: join(output, file),
    bundle: true,
    platform,
    jsx: "automatic",
    format: platform === "node" ? "cjs" : "iife",
    external: ["electron"],
    loader: { ".png": "dataurl", ".svg": "dataurl" },
    plugins: [
      {
        name: "fixture-url-assets",
        setup(builder) {
          builder.onResolve({ filter: /\?raw$/ }, (args) => ({
            path: resolve(args.resolveDir, args.path.slice(0, -4)),
            namespace: "fixture-raw",
          }));
          builder.onLoad({ filter: /.*/, namespace: "fixture-raw" }, async (args) => ({
            contents: await readFile(args.path, "utf8"),
            loader: "text",
          }));
          builder.onResolve({ filter: /\?url$/ }, (args) => ({
            path: require.resolve(args.path.slice(0, -4), { paths: [args.resolveDir] }),
            namespace: "fixture-url",
          }));
          builder.onLoad({ filter: /.*/, namespace: "fixture-url" }, async (args) => ({
            contents: await readFile(args.path),
            loader: "file",
          }));
        },
      },
    ],
    alias,
    define: {
      "process.env.NODE_ENV": '"production"',
      "import.meta.env": '{"DEV":false,"PROD":true,"BASE_URL":"./"}',
    },
    logLevel: "warning",
  });
await Promise.all([
  bundle(join(fixture, "main.ts"), "main.cjs", "node"),
  bundle(join(fixture, "chain-main.ts"), "chain-main.cjs", "node"),
  bundle(join(fixture, "showcase-main.ts"), "showcase-main.cjs", "node"),
  bundle(join(desktop, "src/renderer/src/plugin-sandbox/alias.ts"), "plugin-sandbox-alias.js"),
  bundle(join(fixture, "sampling-main.ts"), "sampling-main.cjs", "node"),
  bundle(join(fixture, "managed-empty-main.ts"), "managed-empty-main.cjs", "node"),
  bundle(join(fixture, "managed-main.ts"), "managed-main.cjs", "node"),
  bundle(join(fixture, "interaction-main.ts"), "interaction-main.cjs", "node"),
  bundle(join(fixture, "rows-main.ts"), "rows-main.cjs", "node"),
  bundle(join(fixture, "managed-renderer.tsx"), "managed.js"),
  bundle(join(fixture, "retention-main.ts"), "retention-main.cjs", "node"),
  bundle(join(fixture, "retention-renderer.ts"), "retention.js"),
  bundle(join(fixture, "preload.ts"), "preload.cjs", "node"),
  bundle(join(fixture, "renderer.ts"), "host.js"),
  bundle(join(fixture, "widget.tsx"), "widget.js"),
  bundle(join(desktop, "src/preload/pluginSandbox/index.ts"), "guest.cjs", "node"),
  bundle(join(desktop, "src/renderer/src/plugin-sandbox/main.ts"), "shell.js"),
]);
await Promise.all([
  writeFile(
    join(output, "host.html"),
    '<!doctype html><body><div id="inline" style="position:absolute;left:20px;top:20px;width:400px;height:300px"></div><div id="sidebar" style="position:absolute;right:20px;top:20px;width:450px;height:600px"></div><script src="host.js"></script>',
  ),
  writeFile(
    join(output, "plugin-sandbox.html"),
    '<!doctype html><style>html,body,#root,iframe{width:100%;height:100%;margin:0;border:0}iframe{display:block}</style><div id="root"></div><script src="/assets/shell.js"></script>',
  ),
  writeFile(
    join(output, "widget.html"),
    '<!doctype html><html><head></head><body><div id="root"></div><script>' +
      (await readFile(join(output, "widget.js"), "utf8")).replaceAll("</script", "<\\/script") +
      "</script></body></html>",
  ),
]);
const { mkdir, copyFile } = await import("node:fs/promises");
await mkdir(join(output, "assets"));
await copyFile(join(output, "shell.js"), join(output, "assets/shell.js"));
await copyFile(join(fixture, "mcp-server.mjs"), join(output, "mcp-server.mjs"));
await writeFile(
  join(output, "retention.html"),
  '<!doctype html><body><script src="retention.js"></script>',
);
await writeFile(
  join(output, "managed.html"),
  '<!doctype html><meta charset="utf-8"><style>.h-full{height:100%}.w-full{width:100%}.flex{display:flex}.flex-col{flex-direction:column}.flex-1{flex:1}.min-h-0{min-height:0}.overflow-y-auto{overflow-y:auto}.relative{position:relative}</style><body><div id="root"></div><script src="managed.js"></script>',
);
const electron = require("electron");
const modes = process.argv.includes("--showcase-only")
  ? ["showcase"]
  : process.argv.includes("--sampling-only")
    ? ["sampling"]
    : process.argv.includes("--rows-only")
      ? ["rows"]
      : process.argv.includes("--managed-only")
        ? ["interaction", "managed", "managed-empty"]
        : process.argv.includes("--chain-only")
          ? ["chain"]
          : process.argv.includes("--retention-only")
            ? ["retention"]
            : process.argv.includes("--storage-only")
              ? ["write", "read", "empty"]
              : [
                  "write",
                  "read",
                  "empty",
                  "chain",
                  "interaction",
                  "managed",
                  "managed-empty",
                  "retention",
                  "rows",
                  "sampling",
                ];
for (const mode of modes) {
  await new Promise((accept, reject) => {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(
      electron,
      mode === "chain" ||
        mode === "interaction" ||
        mode === "managed" ||
        mode === "rows" ||
        mode === "sampling" ||
        mode === "showcase"
        ? [
            join(output, `${mode}-main.cjs`),
            output,
            join(output, `${mode}-profile`),
            process.execPath,
            join(root, "apps/zcode-cli/packages/cli/dist/zcode.cjs"),
            showcaseServer ?? "",
          ]
        : mode === "managed-empty"
          ? [join(output, "managed-empty-main.cjs"), output, join(output, "managed-profile")]
          : mode === "retention"
            ? [join(output, "retention-main.cjs"), output, join(output, "retention-profile")]
            : [join(output, "main.cjs"), output, join(output, "profile"), mode],
      { env, stdio: "inherit" },
    );
    const watchdog = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Electron fixture timed out (${mode})`));
    }, 90_000);
    child.on("error", reject);
    child.on("exit", (code) => {
      clearTimeout(watchdog);
      if (code === 0) accept();
      else reject(new Error(`Electron fixture failed (${mode}): ${code}`));
    });
  });
}
process.stdout.write(
  JSON.stringify(
    {
      output,
      interaction: modes.includes("interaction")
        ? JSON.parse(await readFile(join(output, "interaction-results.json"), "utf8"))
        : undefined,
      showcase: modes.includes("showcase")
        ? JSON.parse(await readFile(join(output, "showcase-results.json"), "utf8"))
        : undefined,
      samplingDatabase: modes.includes("sampling") ? verifySamplingDatabase(output) : undefined,
      sampling: modes.includes("sampling")
        ? JSON.parse(await readFile(join(output, "sampling-results.json"), "utf8"))
        : undefined,
      rows: modes.includes("rows")
        ? JSON.parse(await readFile(join(output, "rows-results.json"), "utf8"))
        : undefined,
      managed: modes.includes("managed")
        ? JSON.parse(await readFile(join(output, "managed-results.json"), "utf8"))
        : undefined,
      managedStorage: modes.includes("managed-empty")
        ? JSON.parse(await readFile(join(output, "managed-storage-empty.json"), "utf8"))
        : undefined,
      chain: modes.includes("chain")
        ? JSON.parse(await readFile(join(output, "chain-results.json"), "utf8"))
        : undefined,
      retention: modes.includes("retention")
        ? JSON.parse(await readFile(join(output, "retention-results.json"), "utf8"))
        : undefined,
      metrics: await Promise.all(
        modes
          .filter((mode) => ["write", "read", "empty"].includes(mode))
          .map(async (mode) =>
            JSON.parse(await readFile(join(output, `metrics-${mode}.json`), "utf8")),
          ),
      ),
    },
    null,
    2,
  ) + "\n",
);
