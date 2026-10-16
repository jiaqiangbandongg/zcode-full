import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
const entry = "/packages/ui/test/browser/manual-review/pending/side-pane-plugin-menu.fixture.tsx";
const surfaces = ["hello", "canvas"].map((id) => ({
  id,
  pluginId: `${id}@example`,
  pluginName: id,
  title: {
    en: id === "hello" ? "Hello panel" : "Canvas",
    "zh-CN": id === "hello" ? "Hello 面板" : "画布",
  },
  server: `plugin:${id}:server`,
  resourceUri: `ui://${id}/panel.html`,
}));
const add = "[data-side-pane-add-tab-trigger]";
const menuItems = '[data-side-pane-add-item^="plugin-ui:"]';
const launcherItems = '[data-side-pane-open-tab-item^="plugin-ui:"]';
let server, browser, origin;

before(async () => {
  server = await createServer({
    root,
    configFile: false,
    plugins: [
      react(),
      tailwindcss(),
      {
        name: "plugin-menu-fixture",
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
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false },
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
  await Promise.all([
    browser?.close().then(() => console.info("Fixture browser closed")),
    server?.close().then(() => console.info("Fixture server closed")),
  ]);
});

for (const [width, locale, theme] of [
  [1200, "en-US", "light"],
  [390, "zh-CN", "dark"],
]) {
  test(`SPT-E2E-007 ${width}/${locale}/${theme}`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 800 } });
    page.setDefaultTimeout(15000);
    page.setDefaultNavigationTimeout(120000);
    const errors = [];
    const scopes = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const query = `locale=${locale}&theme=${theme}${width < 500 ? "&mobile=1" : ""}`;
    await page.route("**/surfaces", (route) => {
      scopes.push(route.request().postDataJSON());
      return route.fulfill({ json: surfaces });
    });
    const read = (id) => page.getByTestId(id).textContent().then(JSON.parse);
    try {
      await page.goto(`${origin}fixture?${query}`, { waitUntil: "domcontentloaded" });
      await page.locator(launcherItems).first().waitFor();
      assert.equal(await page.locator(launcherItems).count(), 2);
      await page.locator(launcherItems).first().click();
      const expected = await read("request");
      assert.deepEqual(expected, {
        parentSessionId: "session-fixture",
        surfaceId: "hello",
        serverName: "plugin:hello:server",
        pluginId: "hello@example",
        resourceUri: "ui://hello/panel.html",
        title: locale === "zh-CN" ? "Hello 面板" : "Hello panel",
        workspacePath: "/workspace/example",
        workspaceIdentity: "fixture-workspace",
        remoteSessionId: "fixture-remote-session",
      });
      await page.getByTestId("show-tabs").click();
      await page.locator(add).click();
      await page.locator(menuItems).first().waitFor();
      assert.equal(await page.locator(menuItems).count(), 2);
      assert.equal(await page.locator(menuItems).first().getAttribute("role"), "menuitem");
      assert.match(await page.locator(menuItems).first().textContent(), new RegExp(expected.title));
      const box = await page.getByRole("menu").boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= width && box.y + box.height <= 800);
      const artifacts = join(tmpdir(), "zcode-side-pane-plugin-menu");
      await mkdir(artifacts, { recursive: true });
      await page.screenshot({ path: join(artifacts, `${width}-${locale}-${theme}.png`) });
      await page.locator(menuItems).first().click();
      await page.getByRole("menu").waitFor({ state: "hidden" });
      assert.deepEqual(await read("request"), expected);
      assert.equal((await read("opened")).tabs.length, 1);
      // End/Enter 必须走菜单自己的键盘选择；最后一项是 Canvas。
      await page.locator(add).focus();
      await page.keyboard.press("Enter");
      await page.locator(menuItems).last().waitFor();
      await page.keyboard.press("End");
      await page.waitForFunction(
        () =>
          document.activeElement?.getAttribute("data-side-pane-add-item") ===
          "plugin-ui:canvas@example/canvas",
      );
      await page.keyboard.press("Enter");
      await page.getByRole("menu").waitFor({ state: "hidden" });
      assert.equal((await read("request")).surfaceId, "canvas");
      assert.equal((await read("opened")).tabs.length, 2);
      assert.ok(scopes.every((scope) => scope.workspaceIdentity === "fixture-workspace"));
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      assert.deepEqual(errors, []);
      for (const mode of ["draft", "noHost", "noBridge", "empty"]) {
        let calls = 0;
        await page.unroute("**/surfaces");
        await page.route("**/surfaces", (route) => {
          calls++;
          return route.fulfill({ json: [] });
        });
        const emptyResponse = mode === "empty" ? page.waitForResponse("**/surfaces") : null;
        await page.goto(`${origin}fixture?${query}&existing=1&${mode}=1`);
        await page.locator(add).click();
        await page.getByRole("menu").waitFor();
        if (emptyResponse) await (await emptyResponse).finished();
        assert.equal(await page.locator(menuItems).count(), 0, mode);
        if (mode !== "empty") assert.equal(calls, 0, mode);
      }
      assert.deepEqual(errors, []);
    } catch (error) {
      const diagnostic = `${String(error)}; pageErrors=${JSON.stringify(errors)}; body=${(await page.locator("body").innerText()).slice(0, 1500)}`;
      console.error(diagnostic);
      throw new Error(diagnostic, { cause: error });
    } finally {
      await page.close();
    }
  });
}
