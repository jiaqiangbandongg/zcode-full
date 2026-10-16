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
const entry = "/packages/ui/test/browser/manual-review/pending/plugin-picker-order.fixture.tsx";
let server;
let browser;
let origin;

before(async () => {
  server = await createServer({
    root,
    configFile: false,
    plugins: [
      {
        name: "unrelated-picker-data-sources",
        load(id) {
          if (id.endsWith("/hooks/useWorkspaceServices.tsx"))
            return 'import {useServices} from "@/hooks/useServices.js"; export function useWorkspaceServicesResolution(){ return {services:useServices(),rpcReady:true,remoteSessionId:"attachment"}; }';
          if (id.endsWith("/v4/activeTaskProvider.ts"))
            return 'export function useChatViewActiveTaskProvider(){return "zcode";}';
          for (const [file, fn] of [
            ["fileMentionProvider", "useFileMentionProvider"],
            ["sessionsMentionProvider", "useSessionsMentionProvider"],
            ["skillsMentionProvider", "useSkillsMentionProvider"],
            ["subagentsMentionProvider", "useSubagentsMentionProvider"],
          ]) {
            if (id.endsWith("/providers/" + file + ".ts"))
              return (
                "export const mapSkillsToMentionItemsForTest=()=>[]; export const mapSubagentsToMentionItemsForTest=()=>[]; export function " +
                fn +
                '(){return {items:[],loading:false,error:null,title:"",emptyText:""};}'
              );
          }
        },
      },
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

const official = "zcode-plugins-official";
const plugin = (name, category, extra = {}) => ({
  pluginId: `${name}@${official}`,
  name,
  marketplace: official,
  category,
  enabled: true,
  conflictingPluginIds: [],
  skillQualifiedNames: [],
  mcpServerNames: [],
  subagentNames: [],
  ...extra,
});
const frozen = [
  plugin("beta", "utilities"),
  plugin("alpha", "utilities"),
  plugin("dev", "developer-tools"),
  plugin("disabled", "utilities", { enabled: false }),
  plugin("conflict", "utilities", { conflictingPluginIds: ["conflict@personal"] }),
  plugin("personal", "utilities", { pluginId: "personal@personal", marketplace: "personal" }),
];
const config = {
  code: {
    categoryOrder: ["developer-tools", "utilities"],
    pluginOrder: { utilities: [`beta@${official}`, `alpha@${official}`] },
  },
  work: {
    categoryOrder: ["utilities", "developer-tools"],
    pluginOrder: { utilities: [`alpha@${official}`, `beta@${official}`] },
  },
};
for (const [width, locale, theme] of [
  [1200, "en-US", "light"],
  [390, "zh-CN", "dark"],
]) {
  test(`PSO-10/11/14 @/+ ${width}/${locale}/${theme}`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const calls = [];
    let requests = 0;
    let release;
    const pending = new Promise((resolve) => (release = resolve));
    await page.route("**/catalog", async (route) => {
      const params = route.request().postDataJSON();
      calls.push(params);
      assert.equal(params.workspaceIdentity, "ssh:fixture");
      assert.equal(params.remoteSessionId, "attachment");
      await route.fulfill({
        json: {
          authority: params.sessionId ? "session" : "workspace",
          plugins: params.sessionId ? frozen : [...frozen, plugin("new", "developer-tools")],
        },
      });
    });
    await page.route("**/order", async (route) => {
      requests++;
      if (requests === 1) await pending;
      await route.fulfill({ json: config });
    });
    const options = () => page.locator('[role="option"][data-section-id="plugins"]');
    const names = () =>
      options().evaluateAll((es) =>
        es.map((e) => e.getAttribute("data-option-id").replace("plugin:", "").split("@")[0]),
      );
    const editor = page.getByTestId("editor");
    try {
      await page.goto(`${origin}fixture?locale=${locale}&theme=${theme}`);
      await editor.waitFor();
      assert.equal(requests, 0);
      await editor.fill("@");
      await options().first().waitFor();
      assert.deepEqual(await names(), ["beta", "alpha", "dev", "conflict", "personal"]);
      release();
      await page.waitForFunction(() =>
        document
          .querySelector('[role="option"][data-section-id="plugins"]')
          ?.getAttribute("data-option-id")
          ?.startsWith("plugin:dev@"),
      );
      assert.deepEqual(await names(), ["dev", "beta", "alpha", "conflict", "personal"]);
      // 模式按钮点击不让编辑器失焦，验证打开菜单期间的本地重排。
      await page.getByTestId("work").evaluate((e) => e.click());
      await page.waitForFunction(() =>
        document
          .querySelector('[role="option"][data-section-id="plugins"]')
          ?.getAttribute("data-option-id")
          ?.startsWith("plugin:alpha@"),
      );
      assert.deepEqual(await names(), ["alpha", "beta", "conflict", "dev", "personal"]);
      assert.equal(requests, 1);
      assert.equal(
        await page
          .locator('[data-option-id="plugin:conflict@zcode-plugins-official"]')
          .getAttribute("data-disabled"),
        "true",
      );
      await editor.fill("@dev");
      await options().first().waitFor();
      await page.waitForFunction(
        () => document.querySelectorAll('[role="option"][data-section-id="plugins"]').length === 1,
      );
      assert.deepEqual(await names(), ["dev"]);
      await editor.fill("");
      await page.getByRole("button", { name: "Add", exact: true }).click();
      await options().first().waitFor();
      assert.deepEqual(await names(), ["alpha", "beta", "conflict", "dev", "personal"]);
      const afterOpen = requests;
      await page.getByTestId("code").evaluate((e) => e.click());
      await page.waitForFunction(() =>
        document
          .querySelector('[role="option"][data-section-id="plugins"]')
          ?.getAttribute("data-option-id")
          ?.startsWith("plugin:dev@"),
      );
      assert.deepEqual(await names(), ["dev", "beta", "alpha", "conflict", "personal"]);
      assert.equal(requests, afterOpen);
      await options().first().click();
      assert.equal(await page.getByTestId("selected").textContent(), `dev@${official}`);
      await page.getByTestId("draft").click();
      await editor.fill("@");
      await options().first().waitFor();
      await page.waitForFunction(
        () => !!document.querySelector('[data-option-id="plugin:new@zcode-plugins-official"]'),
      );
      assert.ok(calls.some((x) => x.sessionId === "frozen-session"));
      assert.ok(calls.some((x) => !x.sessionId));
      assert.deepEqual(errors, []);
      await mkdir(join(tmpdir(), "zcode-plugin-picker-order"), { recursive: true });
      await page.screenshot({
        path: join(tmpdir(), "zcode-plugin-picker-order", `${width}-${locale}.png`),
      });
    } catch (error) {
      console.error(error, { errors, calls, requests }, await page.locator("body").innerText());
      throw error;
    } finally {
      release();
      await page.close();
    }
  });
}

for (const width of [1200, 390]) {
  for (const locale of ["en-US", "zh-CN"]) {
    for (const theme of ["light", "dark"]) {
      test(`PLUGIN-CREATOR-ICON @ token ${width}/${locale}/${theme}`, async () => {
        const page = await browser.newPage({ viewport: { width, height: 900 } });
        page.setDefaultTimeout(10000);
        try {
          await page.route("**/catalog", (route) =>
            route.fulfill({
              json: {
                authority: "session",
                plugins: [plugin("plugin-creator", "utilities")],
              },
            }),
          );
          await page.route("**/order", (route) => route.fulfill({ json: config }));
          await page.goto(`${origin}fixture?locale=${locale}&theme=${theme}`);
          const editor = page.getByTestId("editor");
          await editor.fill("@");
          const option = page.locator(
            '[role="option"][data-option-id="plugin:plugin-creator@zcode-plugins-official"]',
          );
          await option.waitFor();
          const image = option.locator("img");
          assert.match(await image.getAttribute("src"), /plugin-creator\.png/u);
          await page.waitForFunction(() => {
            const image = document.querySelector('[role="option"] img');
            return image?.complete && image.naturalWidth > 0;
          });
          await option.click();
          const token = editor.locator(
            '[data-mention-id="plugin:plugin-creator@zcode-plugins-official"]',
          );
          await token.waitFor();
          assert.match(
            await token.evaluate((node) => node.style.getPropertyValue("--mention-image")),
            /plugin-creator\.png/u,
          );
          assert.equal(await editor.innerText(), "plugin-creator ");
        } finally {
          await page.close();
        }
      });
    }
  }
}
