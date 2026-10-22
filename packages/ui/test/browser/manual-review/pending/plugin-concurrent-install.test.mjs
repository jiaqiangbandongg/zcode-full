import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
const entry =
  "/packages/ui/test/browser/manual-review/pending/plugin-concurrent-install.fixture.tsx";
let server;
let browser;
let origin;

before(async () => {
  server = await createServer({
    root,
    configFile: false,
    plugins: [
      react(),
      tailwindcss(),
      {
        name: "responsive-fixture",
        configureServer(vite) {
          vite.middlewares.use(async (req, res, next) => {
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

const artifacts = join(tmpdir(), "zcode-plugin-concurrent-install");
for (const width of [390, 1200])
  for (const locale of ["en-US", "zh-CN"])
    for (const theme of ["light", "dark"]) {
      test(`PLM-CONCURRENT-INSTALL ${width}/${locale}/${theme}`, async () => {
        const page = await browser.newPage({ viewport: { width, height: 700 } });
        const logs = [];
        page.on("console", (message) => logs.push(message.text()));
        try {
          await page.goto(`${origin}fixture?locale=${locale}&theme=${theme}`);
          const first = page.getByTestId("plugin-store-install").filter({ hasText: /./ }).nth(0);
          const second = page.getByTestId("plugin-store-install").nth(1);
          await first.click();
          await second.click();
          assert.equal(await first.isDisabled(), true, "starting B must keep A disabled");
          assert.equal(await second.isDisabled(), true);
          const busy = locale === "zh-CN" ? "安装中" : "Installing";
          assert.ok((await first.textContent()).includes(busy));
          assert.ok((await second.textContent()).includes(busy));
          await page.getByTestId("finish-second").click();
          await page.waitForFunction(
            () => !document.querySelectorAll('[data-testid="plugin-store-install"]')[1].disabled,
          );
          assert.equal(await first.isDisabled(), true, "finishing B must keep A busy");
          await page.getByTestId("finish-first").click();
          await page.waitForFunction(
            () => !document.querySelector('[data-testid="plugin-store-install"]').disabled,
          );
          await mkdir(artifacts, { recursive: true });
          await page.screenshot({ path: join(artifacts, `${width}-${locale}-${theme}.png`) });
          await writeFile(join(artifacts, `${width}-${locale}-${theme}.log`), logs.join("\n"));
          assert.ok(logs.some((line) => line.includes("install-state")));
        } finally {
          await page.close();
        }
      });
    }
