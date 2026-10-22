import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
const entry = "/packages/ui/test/browser/manual-review/pending/project-device-baseline.fixture.tsx";
const artifacts = join(root, "packages/desktop/.e2e-artifacts/project-device-baseline");
let server, browser, origin;
before(async () => {
  await mkdir(artifacts, { recursive: true });
  server = await createServer({
    root,
    configFile: false,
    plugins: [
      {
        name: "project-device-fixture",
        enforce: "pre",
        load(id) {
          if (id.endsWith("/project-sidebar/ProjectDirectoryProvider.tsx"))
            return "export const useProjectDirectory=()=>window.__projectDeviceDirectory; export const useOptionalProjectDirectory=useProjectDirectory;";
        },
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
      react(),
      tailwindcss(),
    ],
    resolve: { alias: { "@": `${root}packages/ui/src` } },
    optimizeDeps: { entries: [entry.slice(1)] },
    server: { host: "127.0.0.1", port: 0, hmr: false },
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

async function measure(row, deviceTestId, name) {
  return row.evaluate(
    (element, { deviceTestId, name }) => {
      const device = element.querySelector(`[data-testid="${deviceTestId}"]`);
      const title = [...element.querySelectorAll("span")].find(
        (el) => el.textContent === name && el.children.length === 0,
      );
      assertElements();
      function assertElements() {
        if (!device || !title) throw new Error("Missing project/device text");
      }
      const text = (el) => {
        // 零尺寸 inline-block 的顶边就是行内基线，避免用文字框中心冒充文字对齐。
        const marker = document.createElement("i");
        marker.style.cssText = "display:inline-block;width:0;height:0;vertical-align:baseline";
        el.append(marker);
        const baseline = marker.getBoundingClientRect().top;
        marker.remove();
        const style = getComputedStyle(el);
        return {
          baseline,
          fontSize: parseFloat(style.fontSize),
          width: el.clientWidth,
          scrollWidth: el.scrollWidth,
          overflow: style.textOverflow,
        };
      };
      const bounds = element.getBoundingClientRect();
      const icon = element.querySelector("svg.lucide-cloud").getBoundingClientRect();
      return {
        title: text(title),
        device: text(device),
        iconCenterDelta: icon.top + icon.height / 2 - bounds.top - bounds.height / 2,
        right: bounds.right,
        viewport: innerWidth,
      };
    },
    { deviceTestId, name },
  );
}

for (const width of [390, 1200])
  for (const theme of ["light", "dark"])
    for (const locale of ["zh-CN", "en-US"])
      for (const font of [14, 16])
        test(`RDUX-BASELINE ${width}/${theme}/${locale}/${font}`, { timeout: 60000 }, async () => {
          const page = await browser.newPage({ viewport: { width, height: 700 } });
          page.setDefaultTimeout(10000);
          const errors = [];
          page.on("pageerror", (error) => errors.push(error.message));
          try {
            for (const long of [false, true]) {
              const name = long
                ? (locale === "zh-CN" ? "远程项目名称" : "Remote project name ").repeat(8)
                : "dev";
              const device = long
                ? (locale === "zh-CN" ? "研发设备名称" : "Development device ").repeat(8)
                : "DEV-TEST · dev";
              const query = new URLSearchParams({
                theme,
                locale,
                font: String(font),
                mobile: String(Number(width === 390)),
                name,
                device,
              });
              await page.goto(`${origin}fixture?${query}`);
              const sidebar = page.getByTestId("virtual-project-toggle");
              await sidebar.waitFor();
              await page.evaluate(() => document.fonts.ready);
              const sidebarMetrics = await measure(sidebar, "project-device", name);
              await page.getByTestId("composer-workspace-trigger").click();
              const composer = page.locator('[role="menuitemcheckbox"][data-project-id="project"]');
              await composer.waitFor();
              await composer.evaluate(async (element) => {
                await Promise.allSettled(
                  element
                    .closest('[role="menu"]')
                    .getAnimations()
                    .map((animation) => animation.finished),
                );
              });
              const composerMetrics = await measure(composer, "composer-project-device", name);
              const key = `${width}-${theme}-${locale}-${font}-${long ? "long" : "short"}`;
              await page.screenshot({ path: join(artifacts, `${key}.png`) });
              await writeFile(
                join(artifacts, `${key}.json`),
                JSON.stringify({ sidebarMetrics, composerMetrics }, null, 2),
              );
              for (const [surface, metrics] of Object.entries({
                sidebar: sidebarMetrics,
                composer: composerMetrics,
              })) {
                assert.ok(
                  Math.abs(metrics.title.baseline - metrics.device.baseline) < 0.5,
                  `${surface}: text baseline delta ${metrics.device.baseline - metrics.title.baseline}px`,
                );
                assert.equal(metrics.title.fontSize, font);
                assert.equal(metrics.device.fontSize, font - 2);
                assert.ok(
                  Math.abs(metrics.iconCenterDelta) < 0.5,
                  `${surface}: icon must remain centered`,
                );
                assert.ok(metrics.right <= metrics.viewport, `${surface}: row overflows viewport`);
                assert.ok(
                  metrics.title.width > 0 && metrics.device.width > 0,
                  `${surface}: labels must remain visible`,
                );
                if (long) {
                  assert.equal(metrics.title.overflow, "ellipsis");
                  assert.equal(metrics.device.overflow, "ellipsis");
                  assert.ok(metrics.title.scrollWidth > metrics.title.width);
                  assert.ok(metrics.device.scrollWidth > metrics.device.width);
                }
              }
              assert.deepEqual(errors, []);
            }
          } finally {
            await page.close();
          }
        });
