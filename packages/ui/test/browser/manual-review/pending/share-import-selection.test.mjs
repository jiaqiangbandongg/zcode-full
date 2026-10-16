import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
const entry = "/packages/ui/test/browser/manual-review/pending/share-import-selection.fixture.tsx";
const artifacts = join(tmpdir(), "todo139-share-selection");
let server, browser, origin;
before(async () => {
  await mkdir(artifacts, { recursive: true });
  server = await createServer({
    root,
    configFile: false,
    plugins: [
      react(),
      tailwindcss(),
      {
        name: "share-selection-fixture",
        configureServer(vite) {
          vite.middlewares.use(async (req, res, next) => {
            if (!req.url?.startsWith("/fixture?")) return next();
            res.setHeader("Content-Type", "text/html");
            res.end(
              await vite.transformIndexHtml(
                req.url,
                `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1" /></head><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`,
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
});

for (const source of ["root", "recent", "default", "empty", "delayed"])
  for (const width of [390, 1200])
    test(`SHARE30/31/32 ${source} ${width}`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 800 } });
      const errors = [],
        logs = [];
      page.on("pageerror", (error) => errors.push(String(error)));
      page.on("console", (message) => logs.push(message.text()));
      page.setDefaultTimeout(15000);
      const getConfig = async () => JSON.parse(await page.getByTestId("config").textContent());
      try {
        await page.goto(
          `${origin}fixture?source=${source}&locale=${width === 390 ? "zh-CN" : "en-US"}&theme=${width === 390 ? "light" : "dark"}`,
        );
        await page.getByRole("button", { name: "Import", exact: true }).click();
        assert.equal(await page.getByTestId("content").textContent(), "IMPORTED CONTENT");
        if (source === "delayed") {
          assert.equal((await getConfig()).modelSelection, undefined);
          await page.getByLabel("Message").fill("typed before Registry");
          await page.getByRole("button", { name: "Registry ready" }).click();
        }
        if (source === "empty") {
          await page.waitForFunction(
            () =>
              JSON.parse(document.querySelector('[data-testid="config"]').textContent).mode ===
              "plan",
          );
          assert.equal((await getConfig()).modelSelection, undefined);
          assert.equal(
            await page.getByRole("button", { name: "Submit", exact: true }).isDisabled(),
            true,
          );
        } else {
          await page.waitForFunction(
            () =>
              JSON.parse(document.querySelector('[data-testid="config"]').textContent)
                .modelSelection?.options?.reasoningLevel === "high",
          );
          assert.equal(
            (await getConfig()).mode,
            source === "root" ? "plan" : source === "recent" ? "yolo" : "build",
          );
          assert.match(
            await page.getByTestId("chat-model-select-trigger").innerText(),
            /recipient-model/,
          );
          assert.match(
            await page.getByTestId("chat-thought-level-select-trigger").innerText(),
            /High|高/,
          );
          await page.getByRole("button", { name: "Submit", exact: true }).click();
          assert.deepEqual(JSON.parse(await page.getByTestId("submission").textContent()), {
            modelSelection: (await getConfig()).modelSelection,
            mode: (await getConfig()).mode,
          });
        }
        if (source === "root" || source === "empty")
          assert.match(await page.getByTestId("root-draft").textContent(), /ROOT MUST STAY/);
        const imported = await getConfig();
        await page.getByRole("button", { name: "Reopen", exact: true }).click();
        assert.deepEqual(await getConfig(), imported);
        await page.screenshot({ path: join(artifacts, `${source}-${width}.png`) });
        await page.getByRole("button", { name: "Ordinary new task" }).click();
        await page.waitForFunction(
          (expected) => document.querySelector('[data-testid="config"]').textContent === expected,
          JSON.stringify(imported),
        );
        if (source !== "empty") {
          await page.getByRole("button", { name: "Reopen", exact: true }).click();
          await page.getByTestId("chat-thought-level-select-trigger").click();
          await page.getByRole("option", { name: /Low|低/, exact: false }).click();
          await page.waitForFunction(
            () =>
              JSON.parse(document.querySelector('[data-testid="config"]').textContent)
                .modelSelection?.options?.reasoningLevel === "low",
          );
          await page.getByRole("button", { name: "Reopen", exact: true }).click();
          assert.equal((await getConfig()).modelSelection.options.reasoningLevel, "low");
          // 先前提交的快照不随之后改档位变化；重新打开也不重复初始化。
          assert.equal(
            JSON.parse(await page.getByTestId("submission").textContent()).modelSelection.options
              .reasoningLevel,
            "high",
          );
        }
        assert.deepEqual(errors, []);
      } finally {
        await writeFile(
          join(artifacts, `${source}-${width}.log`),
          JSON.stringify({ errors, logs }, null, 2),
        );
        await page.close();
      }
    });
