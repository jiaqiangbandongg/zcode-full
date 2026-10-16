import { build } from "esbuild";
import { mkdtemp, mkdir, readFile, writeFile, readdir, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyGenUiRuntimeAssets } from "./gen-ui-runtime-assets.mjs";
const require = createRequire(import.meta.url);
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(desktop, "../..");
const fixture = join(desktop, "scripts/gen-ui-fixture");
const output = await mkdtemp(join(tmpdir(), "zcode-gen-ui-e2e-"));
await copyGenUiRuntimeAssets(output);
const shared = JSON.parse(await readFile(join(root, "packages/shared/package.json"), "utf8"));
const alias = {
  "@": join(root, "packages/ui/src"),
  ...Object.fromEntries(
    Object.entries(shared.exports).map(([key, path]) => [
      `@zcode/shared${key === "." ? "" : key.slice(1)}`,
      resolve(root, "packages/shared", path),
    ]),
  ),
};
const bundle = (entry, name, platform = "browser") =>
  build({
    entryPoints: [entry],
    outfile: join(output, name),
    bundle: true,
    platform,
    jsx: "automatic",
    format: platform === "node" ? "cjs" : "iife",
    alias,
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
    define: {
      "process.env.NODE_ENV": '"production"',
      "import.meta.env": '{"DEV":false,"PROD":true,"BASE_URL":"./"}',
    },
    logLevel: "warning",
  });
await mkdir(join(output, "assets"));
await Promise.all([
  bundle(join(fixture, "main.ts"), "main.cjs", "node"),
  bundle(join(fixture, "preload.ts"), "preload.cjs", "node"),
  bundle(join(fixture, "renderer.ts"), "host.js"),
  bundle(join(fixture, "react.tsx"), "react.js"),
  bundle(join(desktop, "src/preload/pluginSandbox/index.ts"), "guest.cjs", "node"),
  bundle(join(desktop, "src/renderer/src/plugin-sandbox/main.ts"), "assets/shell.js"),
  bundle(join(desktop, "src/renderer/src/plugin-sandbox/genUi.ts"), "gen-ui.js"),
]);
await writeFile(
  join(output, "host.html"),
  '<!doctype html><meta charset="utf-8"><title>ZCode Gen UI test</title><body><div id="inline" style="position:absolute;left:20px;top:40px;width:700px;height:620px"></div><div id="expanded" style="position:absolute;left:20px;top:20px;width:1000px;height:740px"></div><script src="host.js"></script>',
);
await writeFile(
  join(output, "plugin-sandbox.html"),
  '<!doctype html><meta charset="utf-8"><style>html,body,#root,iframe{width:100%;height:100%;margin:0;border:0}iframe{display:block}</style><div id="root"></div><script src="/assets/shell.js"></script>',
);
await writeFile(
  join(output, "demo.html"),
  `<h1>Original heading</h1><div class="card"><i data-lucide="chart-column"></i><p>Interactive Gen UI</p><div class="nav nav-pills" role="tablist"><button class="nav-link" role="tab" aria-controls="first" aria-selected="true">First</button><button class="nav-link" id="second-tab" role="tab" aria-controls="second">Second</button></div><div id="first" role="tabpanel">First panel</div><div id="second" role="tabpanel">Second panel</div><button class="btn btn-primary" data-tooltip="An accessible tooltip">Inspect</button><div id="preview">Adjustable card</div><div id="modern" aria-label="Second component">Object binding</div></div><script>
window.addEventListener("zcode:error",event=>console.error("ZCODE RUNTIME ERROR",event.detail));window.starts=(window.starts||0)+1;window.initial=window.zcode.widgetState;
window.calendarWasReady=typeof customElements.get('viz-calendar')==='function';
document.body.insertAdjacentHTML('beforeend','<div class="viz-carousel"><div data-variant="First">First option</div><div data-variant="Second">Second option</div></div>');
const settings={spacing:20,color:'#3979df',outline:true,density:'normal'};
const render=()=>{document.querySelector('#preview').style.padding=settings.spacing+'px'};
new Tweak({container:document.getElementById('preview'),onChange:render}).addSlider(settings,'spacing',{label:'Spacing',min:8,max:40}).addColorPicker(settings,'color',{label:'Color'}).addToggle(settings,'outline',{label:'Outline'}).addSelect(settings,'density',{label:'Density',options:['normal','compact']});render();
window.modernSettings={radius:12,variant:'a'}; const modern=document.getElementById('modern');
new Tweak({container:modern,onChange:()=>modern.style.borderRadius=modernSettings.radius+'px'}).addSlider(modernSettings,'radius',{label:'Corner radius',min:0,max:30,unit:'px'}).addSelect(modernSettings,'variant',{options:[{label:'First',value:'a'},{label:'Second',value:'b'}]});
</script>`,
);
const cssFiles = (await readdir(join(desktop, "out/renderer/assets"))).filter((name) =>
  name.endsWith(".css"),
);
if (!cssFiles.length)
  throw new Error(
    "Build the desktop renderer before this E2E: pnpm --dir packages/desktop exec vite build",
  );
await Promise.all(
  cssFiles.map((name) => copyFile(join(desktop, "out/renderer/assets", name), join(output, name))),
);
// 正式正文会加载含 Unicode 正则的 Markdown runtime；fixture 也必须声明 UTF-8，避免本地文件按旧编码解析脚本。
await writeFile(
  join(output, "react.html"),
  `<!doctype html><head><meta charset="utf-8">${cssFiles.map((name) => `<link rel="stylesheet" href="${name}">`).join("")}</head><body><div id="root" style="padding:30px"></div><script src="react.js"></script></body>`,
);
process.stdout.write(`Gen UI E2E artifacts: ${output}\n`);
await writeFile(
  join(output, "standalone-fragment.html"),
  '<p>Standalone state</p><i data-lucide="search"></i><button data-tooltip="Offline tooltip">Details</button><viz-calendar date="2026-09-29" start="09:00" end="12:00"></viz-calendar><script src="https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js"></script><script>window.initialCount=window.zcode.widgetState?.privateContent?.count??0;window.calendarWasReady=typeof customElements.get("viz-calendar")==="function";d3.select(document.body).append("svg").append("rect").attr("data-d3-probe","").attr("width",d3.sum([3,4]));</script>',
);
await promisify(execFile)("python3", [
  join(root, "apps/zcode-cli/packages/visualize-plugin/skills/visualize/scripts/render.py"),
  join(output, "standalone-fragment.html"),
  join(output, "standalone.html"),
]);
const child = spawn(require("electron"), [join(output, "main.cjs"), output], {
  stdio: "inherit",
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "" },
});
const exitCode = await new Promise((resolveExit, reject) => {
  child.on("error", reject);
  child.on("exit", (code) => resolveExit(code ?? 1));
});
process.exitCode = exitCode;
