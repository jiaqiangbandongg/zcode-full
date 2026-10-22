import { build } from "esbuild";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { keepKindLines } from "./kind-filter.mjs";
import { writeNotices } from "./licenses.mjs";
import { readPluginName } from "./plugin-name.mjs";

// Builds the plugin package in the current directory into its dist/. The package declares its
// panel title and formats under "office" in package.json.
// 插件名取自 .zcode-plugin/plugin.json：内置插件包目录名（如 pdf-plugin）与插件名不同。
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = process.cwd();
const pkg = JSON.parse(await readFile(join(target, "package.json"), "utf8"));
const ALL_KINDS = ["docx", "xlsx", "pptx", "pdf"];
const profile = {
  name: await readPluginName(target),
  version: pkg.version,
  title: pkg.office?.title,
  kinds: pkg.office?.kinds,
};
if (
  typeof profile.title?.en !== "string" ||
  typeof profile.title?.["zh-CN"] !== "string" ||
  !Array.isArray(profile.kinds) ||
  !profile.kinds.length ||
  profile.kinds.some((kind) => !ALL_KINDS.includes(kind))
)
  throw new Error(`${target}/package.json: "office" needs title.en, title.zh-CN and kinds`);
const has = (kind) => profile.kinds.includes(kind);

const dist = join(target, "dist");
const ui = join(dist, "ui");
const require = createRequire(import.meta.url);
const pdfjsRoot = dirname(require.resolve("pdfjs-dist/package.json"));
const xlsxRoot = dirname(dirname(require.resolve("@extend-ai/react-xlsx")));
const cjkFontRoot = dirname(require.resolve("@fontsource/noto-sans-sc/package.json"));

await rm(dist, { recursive: true, force: true });
await mkdir(ui, { recursive: true });
await cp(join(root, "LICENSE"), join(dist, "LICENSE"));

if (has("pdf")) {
  // pdf.js data files read by the panel (as resources) and by the server (from disk).
  for (const folder of ["cmaps", "standard_fonts", "wasm"]) {
    await cp(join(pdfjsRoot, folder), join(ui, "pdfjs", folder), {
      recursive: true,
      filter: (path) => !path.endsWith(".js"),
    });
  }
  await cp(join(pdfjsRoot, "build/pdf.worker.min.mjs"), join(ui, "pdf-worker.js"));

  // 系统没有 CJK 字体时的兜底字体（ui/cjkFontRuntime.ts）：Noto Sans SC 400 的编号分片，
  // 每片带自己的 unicode-range，作为同一字体族的多个 FontFace 注册。
  const faces = [];
  await mkdir(join(ui, "fonts"), { recursive: true });
  const css = await readFile(join(cjkFontRoot, "400.css"), "utf8");
  for (const [, file, unicodeRange] of css.matchAll(
    /url\(\.\/files\/(noto-sans-sc-\d+-400-normal\.woff2)\)[^;]*;\s*unicode-range:\s*([^;]+);/g,
  )) {
    await cp(join(cjkFontRoot, "files", file), join(ui, "fonts", file));
    faces.push({ file: `fonts/${file}`, unicodeRange });
  }
  if (faces.length < 50)
    throw new Error(`Noto Sans SC: only ${faces.length} slices; check 400.css`);
  await writeFile(join(ui, "cjk-fallback.json"), JSON.stringify({ faces }));
}

/**
 * Makes the bundles this plugin's: src/profile.ts becomes the plugin's profile, and the format
 * registries keep only the lines tagged with the plugin's formats (`// kind:<format>`).
 */
const officeProfile = {
  name: "office-profile",
  setup(builder) {
    builder.onLoad({ filter: /[\\/]src[\\/]profile\.ts$/ }, () => ({
      contents: `export const PROFILE = ${JSON.stringify(profile)};`,
      loader: "ts",
    }));
    builder.onLoad(
      { filter: /[\\/](src[\\/]adapters[\\/]parsers|ui[\\/]viewers[\\/]registry)\.ts$/ },
      async (args) => ({
        contents: keepKindLines(await readFile(args.path, "utf8"), profile.kinds),
        loader: "ts",
      }),
    );
  },
};

const define = { "process.env.NODE_ENV": '"production"' };
// react-xlsx parses workbooks in a module worker it finds via import.meta.url, which an IIFE bundle
// loses. Ship the worker as an asset and point the library at a blob URL the page creates.
const xlsxWorker = has("xlsx")
  ? await build({
      metafile: true,
      entryPoints: [join(xlsxRoot, "dist/xlsx-worker.js")],
      bundle: true,
      format: "esm",
      platform: "browser",
      target: "es2022",
      minify: true,
      legalComments: "none",
      define,
      write: false,
    })
  : null;
if (xlsxWorker) {
  await cp(join(xlsxRoot, "dist/duke_sheets_wasm_bg.wasm"), join(ui, "sheets.wasm"));
  await writeFile(join(ui, "xlsx-worker.js"), xlsxWorker.outputFiles[0].contents);
}
const xlsxWorkerUrl = {
  name: "xlsx-worker-url",
  setup(builder) {
    builder.onLoad(
      { filter: /@extend-ai[\\/]react-xlsx[\\/]dist[\\/]index\.js$/ },
      async (args) => {
        const source = await readFile(args.path, "utf8");
        const needle = 'new URL("./xlsx-worker.js", import.meta.url)';
        if (!source.includes(needle))
          throw new Error("react-xlsx worker URL not found; update the build patch");
        return {
          contents: source.replace(needle, "globalThis.__officeXlsxWorkerUrl"),
          loader: "js",
        };
      },
    );
  },
};
// pdf.js 画布对未嵌入字体只用同名系统字体或通用族；让它经 ui/cjkFontRuntime.ts 取字体链
// （中日韩字体回退，规格见 docs/plugins/2026-10-15-office-viewer-builtin-panels-spec.md §5）。
const pdfjsCanvasFonts = {
  name: "pdfjs-canvas-fonts",
  setup(builder) {
    builder.onLoad({ filter: /pdfjs-dist[\\/]build[\\/]pdf\.mjs$/ }, async (args) => {
      const source = await readFile(args.path, "utf8");
      const chain = 'fontObj.systemFontInfo?.css || `"${name}", ${fontObj.fallbackName}`';
      const needle = `const typeface = ${chain};`;
      if (!source.includes(needle))
        throw new Error("pdf.js canvas font chain not found; update the build patch");
      // 正斜杠：Windows 绝对路径写进 import 语句时不依赖反斜杠转义。
      const hook = JSON.stringify(join(root, "ui/cjkFontRuntime.ts").replaceAll("\\", "/"));
      return {
        contents: `import { pdfTypeface as __officePdfTypeface } from ${hook};\n${source.replace(
          needle,
          () => `const typeface = __officePdfTypeface(fontObj, ${chain});`,
        )}`,
        loader: "js",
      };
    });
  },
};
const app = await build({
  plugins: [officeProfile, xlsxWorkerUrl, pdfjsCanvasFonts],
  metafile: true,
  entryPoints: [join(root, "ui/main.tsx")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  minify: true,
  legalComments: "none",
  define,
  write: false,
  outdir: ui,
  logOverride: { "direct-eval": "silent" },
});
const js = Buffer.from(app.outputFiles.find((file) => file.path.endsWith(".js")).contents);
// Split the bundle into resources below the host's per-read limit, on UTF-8 boundaries.
const scripts = [];
for (let offset = 0; offset < js.length; ) {
  let end = Math.min(offset + 4 * 1024 * 1024, js.length);
  while (end < js.length && (js[end] & 0xc0) === 0x80) end--;
  const name = `bundle-${scripts.length}.txt`;
  scripts.push(name);
  await writeFile(join(ui, name), js.subarray(offset, end));
  offset = end;
}
await writeFile(join(ui, "assets.json"), JSON.stringify({ scripts, scriptBytes: js.length }));
await writeFile(join(ui, "panel.css"), await readFile(join(root, "ui/panel.css"), "utf8"));

const bootstrap = await build({
  plugins: [officeProfile],
  metafile: true,
  entryPoints: [join(root, "ui/bootstrap.ts")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  minify: true,
  define,
  write: false,
});
const escapeHtml = (text) =>
  text.replace(
    /[&<>"]/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char],
  );
const html = (await readFile(join(root, "ui/panel.html"), "utf8"))
  .replaceAll("__TITLE__", () => escapeHtml(profile.title.en))
  .replace("/*__BOOTSTRAP__*/", () =>
    bootstrap.outputFiles[0].text.replaceAll("</script", "<\\/script"),
  );
await writeFile(join(ui, "panel.html"), html);

// ExcelJS's streaming reader/writer and CSV support are unused (workbooks load through JSZip);
// stub their dependencies so they are not bundled.
const unusedExcelJsDeps = {
  name: "unused-exceljs-deps",
  setup(builder) {
    builder.onResolve({ filter: /^(archiver|unzipper|tmp|fast-csv)$/ }, (args) => ({
      path: args.path,
      namespace: "unused",
    }));
    builder.onLoad({ filter: /.*/, namespace: "unused" }, (args) => ({
      // Module-level calls (tmp.setGracefulCleanup) must still work; any real use throws.
      contents: `const fail = () => { throw new Error(${JSON.stringify(`${args.path} is not bundled`)}); };
module.exports = new Proxy({}, { get: (_, key) => (key === "setGracefulCleanup" ? () => {} : fail) });`,
      loader: "js",
    }));
  },
};
const server = await build({
  plugins: [officeProfile, unusedExcelJsDeps],
  metafile: true,
  entryPoints: [join(root, "src/adapters/main.ts")],
  outfile: join(dist, "server.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  legalComments: "none",
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require=__createRequire(import.meta.url);',
  },
  logOverride: { "direct-eval": "silent" },
});

// Licences of everything bundled, plus the pdf.js / react-xlsx data files copied verbatim.
const notices = join(dist, "THIRD_PARTY_NOTICES.txt");
await writeNotices(
  [app.metafile, bootstrap.metafile, server.metafile, xlsxWorker?.metafile].filter(Boolean),
  notices,
);
const extra = [
  // ui/icons.tsx copies path data from Lucide.
  `lucide icons (path data in ui/icons.tsx) — ISC\nISC License\n\nCopyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT). All other copyright (c) for Lucide are held by Lucide Contributors 2022.\n\nPermission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.\n\nTHE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.`,
];
if (has("pdf"))
  extra.push(
    `@fontsource/noto-sans-sc (ui/fonts, ui/cjk-fallback.json) — OFL-1.1\n${await readFile(join(cjkFontRoot, "LICENSE"), "utf8")}`,
  );
for (const folder of has("pdf") ? ["standard_fonts", "wasm"] : [])
  for (const file of (await readdir(join(pdfjsRoot, folder))).filter((name) =>
    name.startsWith("LICENSE"),
  ))
    extra.push(
      `pdfjs-dist ${folder}/${file}\n${await readFile(join(pdfjsRoot, folder, file), "utf8")}`,
    );
await writeFile(
  notices,
  `${await readFile(notices, "utf8")}\n\n----------------------------------------\n\n${extra.join("\n\n----------------------------------------\n\n")}\n`,
);

const kib = (bytes) => `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
process.stdout.write(
  `${profile.title.en} UI (${profile.kinds.join(", ")}): ${kib(js.length)} in ${scripts.length} resources, loader ${Math.round(Buffer.byteLength(html) / 1024)} KiB\n`,
);
