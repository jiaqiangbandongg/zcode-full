import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  appendFile,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readPluginName } from "./plugin-name.mjs";

/**
 * Real bundled server + official AppBridge host + the panel in an iframe that carries the ZCode
 * sandbox CSP (no network, wasm only by declaration). The script plays the agent: it calls the
 * server's model tools, forwards results to the page and calls the page's capture_view tool.
 * This does not exercise the Electron sandbox itself.
 *
 * Run it from a built plugin package; the steps follow the plugin's formats.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const plugin = process.cwd();
const name = await readPluginName(plugin);
const { kinds } = JSON.parse(await readFile(join(plugin, "package.json"), "utf8")).office;
const has = (kind) => kinds.includes(kind);
const artifacts = resolve(process.env.OFFICE_E2E_ARTIFACTS || join(tmpdir(), `${name}-e2e`));
await mkdir(artifacts, { recursive: true });
const workspace = await mkdtemp(join(tmpdir(), `${name}-e2e-ws-`));
await cp(join(root, "fixtures"), join(workspace, "docs"), {
  recursive: true,
  filter: (path) => !path.endsWith(".py"),
});

const client = new Client({ name: `${name}-e2e`, version: "1" });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [join(plugin, "dist/server.mjs")],
    cwd: workspace,
    env: { PATH: process.env.PATH ?? "", ZCODE_WORKSPACE_ROOT: workspace },
    stderr: "inherit",
  }),
);
const panel = await client.readResource({ uri: `ui://${name}/panel.html` });
const html = panel.contents[0].text;
const relaxed = panel.contents[0]._meta?.["zcode/csp"]?.wasmUnsafeEval === true;
// Same directives as the desktop sandbox (packages/desktop/src/main/pluginSandbox/csp.ts).
const csp = [
  "default-src 'none'",
  `script-src 'self' 'unsafe-inline' blob: data:${relaxed ? " 'wasm-unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'none'",
  "frame-src 'none'",
  "base-uri 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "form-action 'none'",
].join("; ");

const hostJs = await build({
  stdin: {
    contents: `
import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
const rpc = async (method, args) => {
  const response = await fetch('/rpc', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({method,args})});
  const result = await response.json(); if (!response.ok) throw Error(result.error); return result;
};
const params = new URLSearchParams(location.search);
const context = { theme: params.get('theme') || 'light', locale: params.get('locale') || 'en-US', displayMode: params.get('mode') || 'fullscreen' };
const bridge = new AppBridge(null, {name:'office-e2e',version:'1'}, {serverTools:{},serverResources:{},message:{text:{}},updateModelContext:{text:{}},openLinks:{},experimental:{"zcode/surface":{id:"panel",stateKey:params.get("tab")||"first"}}}, {hostContext:context});
window.__messages = []; window.__context = null; window.__links = []; window.__initializations = 0;
bridge.oncalltool = (args) => rpc('callTool', args);
bridge.onreadresource = (args) => rpc('readResource', args);
bridge.onmessage = async (p) => { window.__messages.push(p.content[0].text); return {}; };
bridge.onupdatemodelcontext = async (p) => { window.__context = p; return {}; };
bridge.onopenlink = async (p) => { window.__links.push(p.url); return {}; };
bridge.onsizechange = () => {};
bridge.oninitialized = () => { window.__initializations++; };
window.__sendToolResult = (result) => bridge.sendToolResult(result);
window.__callPageTool = (name, args) => bridge.callTool({ name, arguments: args });
window.__listPageTools = () => bridge.listTools({});
const frame = document.querySelector('iframe');
await bridge.connect(new PostMessageTransport(frame.contentWindow, frame.contentWindow));
frame.src = '/panel';
`,
    resolveDir: root,
    sourcefile: "browser-host.mjs",
  },
  bundle: true,
  format: "esm",
  platform: "browser",
  write: false,
});

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname === "/") {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(
        '<style>html,body{margin:0;width:100%;height:100%}iframe{border:0;width:100%;height:100%}</style><iframe sandbox="allow-scripts allow-same-origin allow-forms"></iframe><script type="module" src="/host.js"></script>',
      );
    } else if (url.pathname === "/host.js") {
      response.setHeader("Content-Type", "text/javascript");
      response.end(hostJs.outputFiles[0].text);
    } else if (url.pathname === "/panel") {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.setHeader("Content-Security-Policy", csp);
      response.end(html);
    } else if (request.method === "POST" && url.pathname === "/rpc") {
      let body = "";
      for await (const chunk of request) body += chunk;
      const { method, args } = JSON.parse(body);
      const result =
        method === "readResource" ? await client.readResource(args) : await client.callTool(args);
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(result));
    } else if (url.pathname === "/favicon.ico") response.writeHead(204).end();
    else response.writeHead(404).end();
  } catch (error) {
    response
      .writeHead(500, { "Content-Type": "application/json" })
      .end(JSON.stringify({ error: String(error) }));
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch(
  process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" },
);
const errors = [];
let opened = 0;
const open = async (
  query = "",
  viewport = { width: Number(process.env.OFFICE_E2E_WIDTH || 900), height: 900 },
  init = null,
) => {
  const outer = await browser.newPage({ viewport });
  if (init) await outer.addInitScript(init);
  outer.on("pageerror", (error) => errors.push(`pageerror: ${error}`));
  outer.on("console", (message) => {
    if (message.type() === "error" && !/favicon/.test(message.text()))
      errors.push(`console: ${message.text()}`);
  });
  const target = new URL(`${base}/${query}`);
  if (!target.searchParams.has("tab"))
    target.searchParams.set("tab", opened++ === 0 ? "first" : `window-${opened}`);
  await outer.goto(target.href);
  await outer.waitForFunction(() => window.__initializations === 1);
  const frame = outer.frames().find((item) => item !== outer.mainFrame());
  assert.ok(frame, "panel iframe exists");
  await frame.locator(".app").waitFor();
  return { outer, frame };
};
/** Play the agent: call a model tool on the server and push the result to the page like the host does. */
const agent = async (outer, name, args) => {
  const result = await client.callTool({ name, arguments: args });
  assert.ok(!result.isError, JSON.stringify(result.content));
  await outer.evaluate((value) => window.__sendToolResult(value), result);
  return result;
};
const capture = async (outer, args, file) => {
  const result = await outer.evaluate(
    (value) => window.__callPageTool("capture_view", value),
    args,
  );
  assert.ok(!result.isError, JSON.stringify(result.content));
  const image = result.content.find((item) => item.type === "image");
  assert.equal(image.mimeType, "image/png");
  const bytes = Buffer.from(image.data, "base64");
  assert.ok(bytes.length > 2000, `${file}: capture is not blank (${bytes.length} bytes)`);
  await writeFile(join(artifacts, file), bytes);
  return result.content.find((item) => item.type === "text").text;
};
const getView = async () =>
  (await client.callTool({ name: "get_view", arguments: { viewId: "first" } })).content[0].text;
const waitForView = async (pattern) => {
  for (let i = 0; i < 40; i++) {
    const text = await getView();
    if (pattern.test(text)) return text;
    await new Promise((done) => setTimeout(done, 150));
  }
  throw new Error(`view never matched ${pattern}: ${await getView()}`);
};

try {
  const width = Number(process.env.OFFICE_E2E_WIDTH || 900);
  let { outer, frame } = await open();
  const shot = (name) => outer.screenshot({ path: join(artifacts, name) });
  let bar = frame.locator(".pop.bar");
  await frame.locator(".empty-open").waitFor();
  await shot("empty.png");
  const tools = await outer.evaluate(() => window.__listPageTools());
  assert.deepEqual(
    tools.tools.map((tool) => tool.name),
    ["capture_view"],
  );

  // 1. File browser → docx; click a paragraph; reference it in chat.
  if (has("docx")) {
    const chooser = outer.waitForEvent("filechooser");
    await frame.locator(".empty-open").click();
    await (await chooser).setFiles(join(root, "fixtures/report.docx"));
    await frame.locator('[data-at="p:4"]').first().waitFor({ timeout: 20000 });
    await outer.reload();
    await outer.waitForFunction(() => window.__initializations === 1);
    const restored = outer.frames().find((item) => item !== outer.mainFrame());
    await restored.locator('[data-at="p:4"]').first().waitFor({ timeout: 20000 });
    // 同一存储分区内的新窗口不能继承服务器的最后文档。
    await outer.goto(base + "/?tab=second");
    await outer.waitForFunction(() => window.__initializations === 1);
    const fresh = outer.frames().find((item) => item !== outer.mainFrame());
    await fresh.locator(".empty-open").waitFor();
    await outer.goto(base);
    await outer.waitForFunction(() => window.__initializations === 1);
    frame = outer.frames().find((item) => item !== outer.mainFrame());
    bar = frame.locator(".pop.bar");
    await frame.locator('[data-at="p:4"]').first().waitFor({ timeout: 20000 });
    await agent(outer, "open_document", { path: "docs/report.docx" });
    await frame.locator('[data-at="p:4"]').first().waitFor({ timeout: 20000 });
    await frame.locator('[data-at="t:1"]').first().waitFor();
    await frame.locator(".pill").waitFor();
    await frame.locator('[data-at="p:4"]').first().click();
    await bar.locator(".where", { hasText: "Paragraph 4" }).waitFor();
    await bar.getByRole("button", { name: "Add to chat" }).click();
    await outer.waitForFunction(() => window.__context !== null);
    const context = await outer.evaluate(() => window.__context);
    assert.match(context.content[0].text, /docs\/report\.docx#p:4: "Revenue grew by 12 percent/);
    await bar.getByText("Added to chat").waitFor();
    await bar.waitFor({ state: "detached", timeout: 4000 });
    await waitForView(/User selection: docs\/report\.docx#p:4/);
    // A table cell click addresses the cell.
    await frame.locator('[data-at="t:1"] td', { hasText: "South" }).click();
    await bar.locator(".where", { hasText: "Table 1 · R3C1" }).waitFor();
    // Ask: the bar grows into a question box and posts a user message with the anchor.
    await bar.getByRole("button", { name: "Ask" }).click();
    await frame.getByPlaceholder("Ask about this…").fill("Is this region growing?");
    await shot("docx-ask.png");
    await frame.locator(".pop.ask").getByRole("button", { name: "Send" }).click();
    await outer.waitForFunction(() => window.__messages.length === 1);
    assert.match(
      await outer.evaluate(() => window.__messages[0]),
      /Is this region growing\?[\s\S]*docs\/report\.docx#t:1\/r3c1/,
    );
    await frame.locator(".pop").waitFor({ state: "detached" });
    // Agent points at a paragraph with a quote: amber mark and a note beside it.
    await agent(outer, "show_in_viewer", {
      targets: [{ anchor: "docs/report.docx#p:6", quote: "steady growth" }],
      note: "Outlook",
    });
    await frame.locator(".callout", { hasText: "Outlook" }).waitFor();
    await shot("docx-panel.png");
    assert.match(
      await capture(outer, { anchor: "docs/report.docx#p:6" }, "docx.png"),
      /Captured docs\/report\.docx#p:6/,
    );
  }

  // 2. Agent opens the PDF at page 2; text layer, quote highlight, link routing, capture.
  if (has("pdf")) {
    await agent(outer, "open_document", { path: "docs/paper.pdf", at: "page:2" });
    await frame
      .locator('.pdf-page[data-at="page:1"] .textLayer span')
      .first()
      .waitFor({ timeout: 20000 });
    await frame.locator(".textLayer span", { hasText: "缓存显著降低延迟" }).waitFor();
    await waitForView(/Visible location: docs\/paper\.pdf#page:2/);
    await frame.locator(".pill .pgin").waitFor();
    // Several targets: the callout steps through them.
    await agent(outer, "show_in_viewer", {
      targets: [
        { anchor: "docs/paper.pdf#page:1", quote: "40 percent reduction" },
        { anchor: "docs/paper.pdf#page:2" },
      ],
      note: "Headline result",
    });
    await frame.locator(".callout", { hasText: "Agent · 1 of 2" }).waitFor();
    await shot("pdf-agent.png");
    await frame.locator(".callout").getByRole("button", { name: "Next" }).click();
    await frame.locator(".callout", { hasText: "Agent · 2 of 2" }).waitFor();
    await frame.locator(".callout").getByRole("button", { name: "Close" }).click();
    await frame.locator(".callout").waitFor({ state: "detached" });
    // Clicking a mark brings its note back (scroll back to it first: Next moved to page 2).
    await frame.evaluate(() => document.querySelector(".viewer-scroll").scrollTo({ top: 0 }));
    await new Promise((done) => setTimeout(done, 300));
    const mark = await frame.evaluate(() => {
      const range = [...CSS.highlights.get("office-reveal")][0];
      const rect = range.getClientRects()[0];
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });
    await frame.page().mouse.click(mark.x, mark.y);
    await frame.locator(".callout", { hasText: "Agent · 1 of 2" }).waitFor();
    assert.equal(await bar.count(), 0, "a click on a mark opens no selection bar");
    await frame.locator(".callout").getByRole("button", { name: "Close" }).click();
    await frame.locator(".pdf-link").first().click();
    await outer.waitForFunction(() => window.__links.length === 1);
    assert.equal(await outer.evaluate(() => window.__links[0]), "https://example.com/paper");
    const box = await frame.locator(".textLayer span", { hasText: "Abstract" }).boundingBox();
    await frame
      .locator('.pdf-page[data-at="page:1"]')
      .first()
      .evaluate(() => {
        const span = [...document.querySelectorAll(".textLayer span")].find((item) =>
          item.textContent.includes("Abstract"),
        );
        const range = document.createRange();
        range.selectNodeContents(span);
        getSelection().removeAllRanges();
        getSelection().addRange(range);
      });
    await frame
      .locator(".textLayer span", { hasText: "Abstract" })
      .dispatchEvent("mouseup", { clientX: box.x, clientY: box.y });
    await bar.getByRole("button", { name: "Copy" }).waitFor();
    await waitForView(/Selected text: """Abstract/);
    await shot("pdf-selection.png");
    await bar.getByRole("button", { name: "Add to chat" }).click();
    await outer.waitForFunction(() => /paper\.pdf#page:1/.test(window.__context?.content[0].text));
    assert.match(
      await outer.evaluate(() => window.__context.content[0].text),
      /docs\/paper\.pdf#page:1: "Abstract/,
    );
    // Find: search as you type, count, step, Esc closes.
    await frame.getByRole("button", { name: "Find" }).click();
    await frame.getByLabel("Find", { exact: true }).fill("percent");
    await frame.locator(".findfield .count", { hasText: /^1 of \d+$/ }).waitFor();
    await frame.getByLabel("Find", { exact: true }).press("Enter");
    await frame.locator(".findfield .count", { hasText: /^2 of \d+$|^1 of 1$/ }).waitFor();
    await shot("pdf-find.png");
    await frame.getByLabel("Find", { exact: true }).press("Escape");
    await frame.locator(".findbar").waitFor({ state: "detached" });
    // Zoom from the page control and back through the More menu.
    await frame.locator(".pill").hover();
    await frame.getByRole("button", { name: "Zoom in (⌘+)" }).click();
    await frame.locator(".pill .zoom", { hasText: "%" }).waitFor();
    await frame.getByRole("button", { name: "More" }).click();
    await frame.getByRole("menuitemradio", { name: "Fit width" }).click();
    await frame.locator(".pill .zoom", { hasText: "Fit" }).waitFor();
    // Pages drawer: thumbnails; picking one goes there.
    await frame.getByRole("button", { name: "Pages and outline" }).click();
    await frame.locator(".drawer .thumb canvas").first().waitFor({ timeout: 10000 });
    await shot("pdf-drawer.png");
    await frame.locator('.drawer .thumb[data-page="2"]').click();
    await waitForView(/Visible location: docs\/paper\.pdf#page:2/);
    if (width < 720) await frame.locator(".drawer").waitFor({ state: "detached" });
    else await frame.getByRole("button", { name: "Pages and outline" }).click();
    assert.match(await capture(outer, { anchor: "docs/paper.pdf#page:1" }, "pdf.png"), /page:1/);
    assert.equal(
      await frame.evaluate(() =>
        Math.round(document.querySelector(".docbar").getBoundingClientRect().top),
      ),
      0,
      "the document bar stays at the top of the panel",
    );
    await shot("pdf-panel.png");
  }

  // 2b. CJK with non-embedded fonts: the panel registers same-style system CJK faces, radicals in
  // ToUnicode read as ideographs, and with no CJK font installed the bundled fallback draws them.
  if (has("pdf")) {
    await agent(outer, "open_document", { path: "docs/cjk.pdf" });
    await frame.locator(".textLayer span", { hasText: "天地玄黄" }).waitFor({ timeout: 20000 });
    assert.ok(
      await frame.evaluate(() =>
        [...document.fonts].some(
          (face) => face.family.startsWith("zcode-cjk-") && face.status === "loaded",
        ),
      ),
      "CJK faces are registered before the page is drawn",
    );
    await agent(outer, "show_in_viewer", {
      targets: [{ anchor: "docs/cjk.pdf#page:1", quote: "天地玄黄" }],
      note: "Radicals read as ideographs",
    });
    await frame.locator(".callout", { hasText: "Radicals read as ideographs" }).waitFor();
    await shot("pdf-cjk.png");
    await frame.locator(".callout").getByRole("button", { name: "Close" }).click();
    await frame.getByRole("button", { name: "Find" }).click();
    await frame.getByLabel("Find", { exact: true }).fill("文");
    await frame.locator(".findfield .count", { hasText: /^1 of 4$/ }).waitFor();
    await frame.getByLabel("Find", { exact: true }).press("Escape");
    await frame.locator(".findbar").waitFor({ state: "detached" });

    // No CJK font on the machine: every local() lookup fails, as on a minimal Linux.
    const bare = await open("", undefined, () => {
      const NativeFontFace = window.FontFace;
      window.FontFace = class extends NativeFontFace {
        constructor(family, source, descriptors) {
          const local = typeof source === "string" && source.includes("local(");
          super(family, local ? 'local("zcode-e2e-missing")' : source, descriptors);
        }
      };
    });
    await agent(bare.outer, "open_document", { path: "docs/cjk.pdf" });
    await bare.frame.waitForFunction(
      () =>
        [...document.fonts].filter(
          (face) => face.family === "zcode-cjk-fallback" && face.status === "loaded",
        ).length >= 50,
      null,
      { timeout: 30000 },
    );
    assert.equal(
      await bare.frame.evaluate(() =>
        [...document.fonts].some((face) => /^zcode-cjk-(sc|tc|jp|kr)-/.test(face.family)),
      ),
      false,
      "faces without an installed font are not registered",
    );
    await bare.frame.locator('.pdf-page[data-at="page:1"] canvas').waitFor({ timeout: 20000 });
    await bare.outer.screenshot({ path: join(artifacts, "pdf-cjk-fallback.png") });
    await bare.outer.close();
  }

  // 3. Presentation: slide rendering, shape hit testing, reveal of a shape, capture.
  if (has("pptx")) {
    await agent(outer, "open_document", { path: "docs/launch.pptx" });
    await frame
      .locator('.slide-frame[data-at="slide:2"] .slide-host > :not(.slide-overlay)')
      .first()
      .waitFor({ timeout: 20000 });
    const hit = (
      await client.callTool({
        name: "search_document",
        arguments: { path: "docs/launch.pptx", query: "Owner" },
      })
    ).structuredContent.hits[0].anchor;
    await agent(outer, "show_in_viewer", { targets: [{ anchor: hit }] });
    await frame.locator(".shape-revealed").waitFor();
    await new Promise((done) => setTimeout(done, 1000)); // let the smooth scroll settle
    const owner = await frame.locator(".shape-revealed").boundingBox();
    await frame.page().mouse.click(owner.x + owner.width / 2, owner.y + owner.height / 2);
    await bar.locator(".where", { hasText: "Slide 2 · Shape" }).waitFor();
    const selected = await waitForView(/User selection: docs\/launch\.pptx#slide:2\/shape:\d+/);
    assert.ok(selected.includes(`User selection: ${hit}`), selected);
    assert.match(selected, /Owner: Dana/);
    assert.match(
      await capture(outer, { anchor: "docs/launch.pptx#slide:3" }, "pptx.png"),
      /slide:3/,
    );
    await shot("pptx-panel.png");
  }

  // 4. Spreadsheet (wasm under CSP): reveal a range, select cells, capture.
  if (has("xlsx")) {
    await agent(outer, "show_in_viewer", {
      targets: [{ anchor: "docs/budget.xlsx#Revenue!B2:D4" }],
    });
    await waitForView(/Visible location: docs\/budget\.xlsx#Revenue/);
    await waitForView(/User selection: docs\/budget\.xlsx#Revenue!B2:D4/);
    const view = await getView();
    assert.match(view, /100\t110\t120/);
    await agent(outer, "show_in_viewer", { targets: [{ anchor: "docs/budget.xlsx#Notes!B2" }] });
    await frame.locator(".sheet-tabs button.active", { hasText: "Notes" }).waitFor();
    assert.match(await capture(outer, {}, "xlsx.png"), /Captured docs\/budget\.xlsx#Notes/);
    // The grid is a canvas: press inside it and the bar names the cell that got selected.
    const grid = await frame.locator(".xlsx-grid").boundingBox();
    await frame.page().mouse.click(grid.x + grid.width * 0.4, grid.y + grid.height * 0.25);
    await bar.locator(".where", { hasText: /^Notes · [A-Z]+\d+$/ }).waitFor();
    await shot("xlsx-panel.png");
  }

  // capture_view refuses a document that is not open.
  const refused = await outer.evaluate(
    (anchor) => window.__callPageTool("capture_view", { anchor }),
    {
      docx: "docs/other.docx#p:1",
      xlsx: "docs/other.xlsx#Sheet1!A1",
      pptx: "docs/other.pptx#slide:1",
      pdf: "docs/other.pdf#page:1",
    }[kinds[0]],
  );
  assert.ok(refused.isError && /open_document/.test(refused.content[0].text));

  // 两个窗口上报后，模型必须先选择窗口，不能收到最后上报者的选区。
  await client.callTool({
    name: "report_view",
    arguments: {
      viewId: "other-window",
      path: {
        docx: "docs/report.docx",
        pdf: "docs/paper.pdf",
        xlsx: "docs/budget.xlsx",
        pptx: "docs/launch.pptx",
      }[kinds[0]],
      at: null,
    },
  });
  const ambiguous = await client.callTool({ name: "get_view", arguments: {} });
  assert.equal(ambiguous.structuredContent.ambiguous, true);
  assert.ok(ambiguous.structuredContent.views.some((view) => view.viewId === "other-window"));
  await client.callTool({ name: "release_view", arguments: { viewId: "other-window" } });

  // 5. The file changes on disk: a notice offers to reload.
  if (has("pdf")) {
    await copyFile(join(workspace, "docs/paper.pdf"), join(workspace, "docs/draft.pdf"));
    await agent(outer, "open_document", { path: "docs/draft.pdf" });
    // Wait for the panel to report the new file: the previous PDF's canvas matches too, and
    // editing the file before the panel loads it would leave nothing to notice.
    await waitForView(/Visible location: docs\/draft\.pdf/);
    await frame.locator('.pdf-page[data-at="page:1"] canvas').waitFor({ timeout: 20000 });
    await appendFile(join(workspace, "docs/draft.pdf"), "\n% edited\n");
    await frame
      .locator(".banner", { hasText: "This file changed on disk." })
      .waitFor({ timeout: 10000 });
    await shot("changed.png");
    await frame.locator(".banner").getByRole("button", { name: "Reload" }).click();
    await frame.locator(".banner").waitFor({ state: "detached" });
    await frame.locator('.pdf-page[data-at="page:1"] canvas').waitFor({ timeout: 20000 });

    // 6. A damaged file shows a plain error with one way forward.
    await writeFile(join(workspace, "docs/broken.pdf"), "not a pdf");
    const brokenChooser = outer.waitForEvent("filechooser");
    await frame.getByRole("button", { name: /Switch document/ }).click();
    await frame.getByRole("menuitem", { name: "Open file" }).click();
    await (await brokenChooser).setFiles(join(workspace, "docs/broken.pdf"));
    await frame.locator(".failed h3").waitFor();
    await shot("error.png");
    const retryChooser = outer.waitForEvent("filechooser");
    await frame.getByRole("button", { name: "Open another file" }).click();
    await (await retryChooser).setFiles(join(workspace, "docs/paper.pdf"));
    await frame.locator(".pdf-page canvas").first().waitFor({ timeout: 20000 });
  }

  // 7. 新的深色中文窗口由 Agent 显式打开文档，不继承其他窗口。
  const inline = has("xlsx")
    ? ["docs/budget.xlsx", ".xlsx-root"]
    : has("pdf")
      ? ["docs/paper.pdf", ".pdf-page canvas"]
      : has("pptx")
        ? ["docs/launch.pptx", '.slide-frame[data-at="slide:1"] .slide-host > :not(.slide-overlay)']
        : ["docs/report.docx", '[data-at="p:1"]'];
  await agent(outer, "open_document", { path: inline[0] });
  const dark = await open("?theme=dark&locale=zh-CN&mode=inline", { width: 420, height: 380 });
  await agent(dark.outer, "open_document", { path: inline[0] });
  await dark.frame.locator(inline[1]).first().waitFor({ timeout: 20000 });
  assert.equal(await dark.frame.locator("html").getAttribute("data-theme"), "dark");
  await dark.frame.getByRole("button", { name: "在侧栏打开" }).first().waitFor();
  assert.ok(
    await dark.frame.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    "no horizontal overflow at 420px",
  );
  await dark.outer.screenshot({ path: join(artifacts, "zh-dark-inline.png") });

  // 8. Dark side panel opened by the agent while ZCode animates the pane's width: the mark must
  // end up on the live text layer, not on one a resize replaced.
  const darkPanel = has("pdf") ? await open("?theme=dark", { width: 300, height: 760 }) : null;
  if (darkPanel) {
    await agent(darkPanel.outer, "show_in_viewer", {
      targets: [{ anchor: "docs/paper.pdf#page:1", quote: "40 percent reduction" }],
      note: "The headline result.",
    });
    for (let w = 300; w <= 460; w += 8) {
      await darkPanel.outer.setViewportSize({ width: w, height: 760 });
      await new Promise((done) => setTimeout(done, 16));
    }
    await darkPanel.outer.setViewportSize({ width: 440, height: 760 });
    await darkPanel.frame.locator(".callout", { hasText: "The headline result." }).waitFor({
      timeout: 20000,
    });
    await darkPanel.frame.waitForFunction(
      () => {
        const ranges = [...(CSS.highlights.get("office-reveal") ?? [])];
        return ranges.some((range) => {
          const rect = range.getBoundingClientRect();
          return (
            range.startContainer.isConnected &&
            range.startContainer.parentElement?.closest(".textLayer")?.isConnected &&
            rect.width > 0 &&
            rect.top >= 0 &&
            rect.bottom <= innerHeight
          );
        });
      },
      null,
      { timeout: 10000 },
    );
    await darkPanel.outer.screenshot({ path: join(artifacts, "pdf-dark.png") });
  }

  for (const page of [frame, dark.frame, darkPanel?.frame].filter(Boolean))
    assert.equal(
      await page.evaluate(() =>
        Math.round(document.querySelector(".docbar").getBoundingClientRect().top),
      ),
      0,
      "the document bar stays at the top after all interactions",
    );
  assert.deepEqual(errors, []);
  process.stdout.write(`${name} e2e (${kinds.join(", ")}): ok (screenshots in ${artifacts})\n`);
} catch (error) {
  // 先输出断言错误，避免连接清理等待掩盖实际失败位置。
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  for (const page of browser.contexts().flatMap((context) => context.pages()))
    await page
      .screenshot({ path: join(artifacts, `failure-${Date.now()}.png`) })
      .catch(() => undefined);
  process.stderr.write(`Browser errors:\n${errors.join("\n")}\nScreenshots in ${artifacts}\n`);
  throw error;
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
  await client.close();
  await rm(workspace, { recursive: true, force: true });
}
