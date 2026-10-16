import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright-core";
import { createFileService } from "../../../../../services/src/file/fileService.ts";

const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
const entry =
  "/packages/ui/test/browser/manual-review/pending/file-mention-host-search.fixture.tsx";
const calls = [];
let workspace;
let server;
let browser;
let origin;
before(async () => {
  workspace = await mkdtemp(join(tmpdir(), "zcode-mfh-browser-"));
  await writeFile(join(workspace, ".zcodeignore"), "");
  await Promise.all(
    Array.from({ length: 1200 }, (_, index) =>
      writeFile(join(workspace, `MFH_BULK_${index}.ts`), ""),
    ),
  );
  const service = createFileService();
  server = await createServer({
    root,
    configFile: false,
    plugins: [
      {
        name: "unrelated-mention-providers",
        load(id) {
          for (const [file, name] of [
            ["sessionsMentionProvider", "useSessionsMentionProvider"],
            ["skillsMentionProvider", "useSkillsMentionProvider"],
            ["pluginsMentionProvider", "usePluginsMentionProvider"],
            ["whiteboardMentionProvider", "useWhiteboardMentionProvider"],
          ]) {
            if (id.endsWith(`/providers/${file}.ts`))
              return `export function ${name}(){return {items:[],loading:false,error:null,title:"",emptyText:""};}`;
          }
        },
      },
      react(),
      tailwindcss(),
      {
        name: "host-file-search-fixture",
        configureServer(vite) {
          vite.middlewares.use(async (req, res, next) => {
            if (req.url === "/search-files") {
              try {
                let body = "";
                for await (const chunk of req) body += chunk;
                const params = JSON.parse(body);
                assert.equal(params.rootPath, workspace);
                assert.equal(params.workspaceIdentity, "ssh:test-host");
                const entries = await service.searchWorkspaceFiles(params);
                calls.push({ params, count: entries.length });
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify(entries));
              } catch (error) {
                res.statusCode = 500;
                res.end(String(error));
              }
              return;
            }
            if (!req.url?.startsWith("/fixture?")) return next();
            res.setHeader("Content-Type", "text/html");
            res.end(
              await vite.transformIndexHtml(
                req.url,
                `<html><head><meta name="viewport" content="width=device-width, initial-scale=1" /></head><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`,
              ),
            );
          });
        },
      },
    ],
    resolve: { alias: { "@": `${root}packages/ui/src` } },
    optimizeDeps: { entries: [entry.slice(1)] },
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  origin = server.resolvedUrls.local[0];
  browser = await chromium.launch(
    process.env.CHROME_EXECUTABLE_PATH
      ? { executablePath: process.env.CHROME_EXECUTABLE_PATH }
      : { channel: "chrome" },
  );
});
after(async () => {
  await browser?.close();
  await server?.close();
  if (workspace) await rm(workspace, { recursive: true, force: true });
});

for (const [width, locale, theme] of [
  [1200, "en-US", "light"],
  [390, "zh-CN", "dark"],
]) {
  test(`MFH01 真实 Host 查询与 @ 选择 ${width}/${locale}/${theme}`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(
      `${origin}fixture?workspace=${encodeURIComponent(workspace)}&locale=${locale}&theme=${theme}`,
    );
    const editor = page.getByTestId("editor");
    await editor.fill("@MFH_BULK");
    await page.locator('[data-option-id="file:MFH_BULK_0.ts"]').waitFor();
    assert.ok(calls.some(({ params, count }) => params.query === "MFH_BULK" && count === 1000));
    assert.ok(
      calls.every(({ params, count }) => count <= params.limit),
      JSON.stringify(calls),
    );
    await editor.fill("@MFH_BULK_1199.ts");
    const option = page.locator('[data-option-id="file:MFH_BULK_1199.ts"]');
    await option.waitFor();
    await option.click();
    await editor.press("End");
    await editor.pressSequentially(" continue");
    assert.match(await editor.innerText(), /MFH_BULK_1199.ts/);
    assert.match(await editor.innerText(), /continue/);
    assert.deepEqual(errors, []);
    const artifacts = join(tmpdir(), "zcode-file-mention-host-search");
    await mkdir(artifacts, { recursive: true });
    await page.screenshot({ path: join(artifacts, `${width}-${theme}.png`), fullPage: true });
    await page.close();
  });
}
