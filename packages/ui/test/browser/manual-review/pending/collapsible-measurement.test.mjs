// SPT05：真实 ToolLayout / Radix / CSS；无 provider，采集隐藏测量和动画生命周期。
import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { chromium, _electron } from "playwright-core";

const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
const entry = "/packages/ui/test/browser/manual-review/pending/collapsible-measurement.fixture.tsx";
const artifacts =
  process.env.ZCODE_E2E_ARTIFACT_DIR ||
  join(root, "packages/desktop/.e2e-artifacts/collapsible-measurement");
let server, browser, electron, origin;
before(async () => {
  await mkdir(artifacts, { recursive: true });
  server = await createServer({
    root,
    configFile: false,
    plugins: [
      {
        name: "collapsible-fixture",
        enforce: "pre",
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
  if (process.env.ZCODE_COLLAPSIBLE_ELECTRON_PATH) {
    const main = join(artifacts, "renderer.cjs");
    await writeFile(
      main,
      'const {app,BrowserWindow}=require("electron");app.setPath("userData",require("node:path").join(__dirname,"electron-profile"));let window;app.whenReady().then(()=>{window=new BrowserWindow({show:true,webPreferences:{nodeIntegration:false,contextIsolation:true,backgroundThrottling:false}});window.loadURL("about:blank");});',
    );
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    electron = await _electron.launch({
      executablePath: process.env.ZCODE_COLLAPSIBLE_ELECTRON_PATH,
      args: [main],
      env,
    });
  } else {
    browser = await chromium.launch(
      process.env.CHROME_EXECUTABLE_PATH
        ? { executablePath: process.env.CHROME_EXECUTABLE_PATH }
        : { channel: "chrome" },
    );
  }
});
after(async () => {
  await electron?.close();
  await browser?.close();
  await server?.close();
});

for (const mobile of [false, true])
  for (const theme of ["light", "dark"]) {
    test(`SPT05 ${mobile ? "mobile" : "desktop"}/${theme}`, async () => {
      const page = electron
        ? await electron.firstWindow({ timeout: 30000 })
        : await browser.newPage({ isMobile: mobile, hasTouch: mobile });
      await page.setViewportSize({ width: mobile ? 430 : 1250, height: 800 });
      const errors = [];
      const onError = (error) => errors.push(String(error));
      page.on("pageerror", onError);
      const evidence = { measurements: [], errors };
      const client = await page.context().newCDPSession(page);
      await client.send("Performance.enable");
      const metrics = async () =>
        Object.fromEntries(
          (await client.send("Performance.getMetrics")).metrics.map(({ name, value }) => [
            name,
            value,
          ]),
        );
      const frames = () =>
        page.evaluate(
          () =>
            new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        );
      const waitHidden = (id, hidden) =>
        page.waitForFunction(({ id, hidden }) => document.getElementById(id)?.hidden === hidden, {
          id,
          hidden,
        });
      try {
        await page.addInitScript(() => {
          window.__foldProbe = { hiddenReads: 0, reads: 0, animations: [] };
          const measure = Element.prototype.getBoundingClientRect;
          Element.prototype.getBoundingClientRect = function (...args) {
            if (this.hasAttribute("data-state")) {
              window.__foldProbe.reads++;
              if (this.hidden) window.__foldProbe.hiddenReads++;
            }
            return measure.apply(this, args);
          };
          document.addEventListener(
            "animationstart",
            (event) => {
              if (event.target.dataset.slot === "collapsible-content")
                window.__foldProbe.animations.push({
                  name: event.animationName,
                  state: event.target.dataset.state,
                });
            },
            true,
          );
        });
        await page.goto(`${origin}fixture?mobile=${mobile}&theme=${theme}`);
        await page.getByRole("button", { name: "Mount", exact: true }).waitFor();
        for (let iteration = 0; iteration < 3; iteration++) {
          const previous = await metrics();
          await page.evaluate(() => {
            window.__foldProbe.hiddenReads = 0;
            window.__foldProbe.reads = 0;
            window.__mountStart = performance.now();
          });
          await page.getByRole("button", { name: "Mount", exact: true }).click();
          await page.waitForFunction(
            () =>
              document.querySelectorAll('[data-testid^="tool-summary-trigger-measurement-"]')
                .length === 134,
          );
          await frames();
          const current = await metrics();
          evidence.measurements.push({
            ...(await page.evaluate(() => ({
              hiddenReads: window.__foldProbe.hiddenReads,
              reads: window.__foldProbe.reads,
              elapsedMs: performance.now() - window.__mountStart,
            }))),
            ...Object.fromEntries(
              [
                "TaskDuration",
                "LayoutDuration",
                "RecalcStyleDuration",
                "LayoutCount",
                "RecalcStyleCount",
              ].map((name) => [name, current[name] - previous[name]]),
            ),
          });
          if (iteration < 2) await page.getByRole("button", { name: "Mount", exact: true }).click();
        }
        const trigger = page.getByTestId("tool-summary-trigger-measurement-0");
        const id = await trigger.getAttribute("aria-controls");
        await trigger.focus();
        await page.keyboard.press("Enter");
        await waitHidden(id, false);
        await page.waitForFunction(() =>
          window.__foldProbe.animations.some((event) => event.state === "open"),
        );
        await page.getByTestId("detail-0").waitFor();
        await page.getByTestId("tool-summary-trigger-measurement-nested").click();
        await page.getByTestId("nested-detail").waitFor();
        await page.getByRole("button", { name: "Width", exact: true }).click();
        assert.equal(await trigger.getAttribute("aria-expanded"), "true");
        await page.getByRole("button", { name: "Mount", exact: true }).click();
        await page.getByRole("button", { name: "Mount", exact: true }).click();
        await page.getByTestId("nested-detail").waitFor();
        assert.equal(await trigger.getAttribute("aria-expanded"), "true");
        const remountedId = await trigger.getAttribute("aria-controls");
        await frames();
        await trigger.click();
        await page.waitForFunction(() =>
          window.__foldProbe.animations.some((event) => event.state === "closed"),
        );
        await waitHidden(remountedId, true);
        // 收起过程中反向打开，不能被旧 animationend 或卸载回调清空。
        await trigger.click();
        await frames();
        await trigger.click();
        await frames();
        await trigger.click();
        await page.getByTestId("detail-0").waitFor();
        await page.waitForFunction(
          (id) => document.getElementById(id)?.getAnimations({ subtree: true }).length === 0,
          remountedId,
        );
        assert.equal(await trigger.getAttribute("aria-expanded"), "true");
        assert.ok(await page.getByTestId("nested-detail").isVisible());
        await page.getByRole("button", { name: "Special", exact: true }).click();
        for (const name of ["default-content", "force-content"]) {
          const value = await page.getByTestId(name).evaluate((node) => ({
            hidden: node.hidden,
            height: Number.parseFloat(
              node.style.getPropertyValue("--radix-collapsible-content-height"),
            ),
          }));
          assert.equal(value.hidden, false);
          assert.ok(value.height > 0, JSON.stringify(value));
        }
        assert.ok(await page.getByRole("button", { name: "Disabled", exact: true }).isDisabled());
        await page.getByTestId("auto-detail").waitFor();
        await page.getByRole("button", { name: "Complete", exact: true }).click();
        const autoTrigger = page.getByTestId("tool-summary-trigger-measurement-auto");
        await waitHidden(await autoTrigger.getAttribute("aria-controls"), true);
        await autoTrigger.click();
        await page.getByTestId("auto-detail").waitFor();
        await page.getByRole("button", { name: "Accordion", exact: true }).click();
        await page.getByTestId("accordion-detail").waitFor();
        await page.getByRole("button", { name: "Accordion", exact: true }).click();
        assert.equal(
          await page
            .getByRole("button", { name: "Accordion", exact: true })
            .getAttribute("aria-expanded"),
          "false",
        );
        await trigger.scrollIntoViewIfNeeded();
        await page.screenshot({
          path: join(artifacts, `${mobile ? "mobile" : "desktop"}-${theme}.png`),
        });
        evidence.animations = await page.evaluate(() => window.__foldProbe.animations);
        assert.deepEqual(errors, []);
        assert.ok(
          evidence.measurements.every((sample) => sample.hiddenReads === 0),
          JSON.stringify(evidence.measurements),
        );
      } finally {
        await writeFile(
          join(artifacts, `${mobile ? "mobile" : "desktop"}-${theme}.json`),
          JSON.stringify(evidence, null, 2),
        );
        page.off("pageerror", onError);
        await client.detach();
        if (!electron) await page.close();
      }
    });
  }
