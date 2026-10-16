import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright-core";
import {
  observeSessionDebug,
  readSessionDebug,
} from "../../../../../../apps/zcode-cli/packages/bootstrap/src/zcode-protocol/session-debug.ts";
const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
const entry = "/packages/ui/test/browser/manual-review/pending/developer-tools.fixture.tsx";
const record = { app: { sessionId: "session-1" } };
observeSessionDebug(record, {
  type: "model_network_status",
  id: "event-1",
  sessionId: "session-1",
  traceId: "trace-1",
  sequenceNumber: 1,
  timestamp: new Date(10000),
  payload: {
    type: "model_request_completed",
    requestId: "request-1",
    querySource: "main_turn",
    timestamp: new Date(10000).toISOString(),
    providerId: "debug-provider",
    modelId: "debug-model",
    transport: "sse",
    attempt: 1,
    maxAttempts: 0,
    durationMs: 5000,
    timeToFirstContentMs: 2000,
    usage: { inputTokens: 1000, outputTokens: 120, cacheReadTokens: 800 },
    requestHeaders: { authorization: "[redacted]" },
    responseHeaders: { "x-request-id": "upstream-request" },
  },
});
let server, browser, origin;
const artifacts = join(root, "packages/desktop/.e2e-artifacts/developer-tools-browser");
before(async () => {
  await mkdir(artifacts, { recursive: true });
  server = await createServer({
    root,
    configFile: false,
    plugins: [
      react(),
      tailwindcss(),
      {
        name: "debug-fixture",
        configureServer(vite) {
          vite.middlewares.use(async (req, res, next) => {
            if (req.url === "/debug") {
              let body = "";
              for await (const chunk of req) body += chunk;
              const target = JSON.parse(body);
              assert.equal(target.workspaceIdentity, "ssh:debug");
              res.setHeader("Content-Type", "application/json");
              res.end(
                JSON.stringify(
                  target.sessionId === "session-1"
                    ? readSessionDebug(record)
                    : { sessionId: target.sessionId, rounds: [], networkEntries: [], cache: null },
                ),
              );
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
});
for (const width of [390, 1200])
  for (const theme of ["light", "dark"]) {
    test(`DBG02 panel ${width}/${theme}`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 1000 } });
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      try {
        await page.goto(
          `${origin}fixture?theme=${theme}&locale=${width === 390 ? "zh-CN" : "en-US"}`,
        );
        const tps = page.getByTestId("token-debug-tps");
        await tps.waitFor();
        assert.equal(await tps.innerText(), "40");
        assert.equal(
          await tps.evaluate((el) => getComputedStyle(el).color),
          await page
            .locator("tbody td")
            .first()
            .evaluate((el) => getComputedStyle(el).color),
        );
        assert.ok(
          (await page.getByTestId("developer-tools-pane").innerText()).includes("debug-model"),
        );
        const summary = page.locator("summary").first();
        await summary.click();
        assert.ok((await page.locator("body").innerText()).includes("[redacted]"));
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        );
        await page.screenshot({ path: join(artifacts, `${width}-${theme}.png`), fullPage: true });
        await page.getByText("Switch task", { exact: true }).click();
        await tps.waitFor({ state: "detached" });
        assert.ok(
          !(await page.getByTestId("developer-tools-pane").innerText()).includes("debug-model"),
        );
        assert.deepEqual(errors, []);
      } finally {
        await page.close();
      }
    });
  }
