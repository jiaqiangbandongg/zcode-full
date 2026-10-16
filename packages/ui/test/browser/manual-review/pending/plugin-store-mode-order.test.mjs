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
const entry = "/packages/ui/test/browser/manual-review/pending/plugin-store-mode-order.fixture.tsx";
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

const official = "zcode-plugins-official";
const config = {
  code: {
    categoryOrder: ["legal", "developer-tools", "productivity"],
    pluginOrder: { productivity: [`p7@${official}`, `p6@${official}`] },
  },
  work: {
    categoryOrder: ["other", "legal", "productivity", "developer-tools"],
    pluginOrder: { productivity: [`p5@${official}`, `p4@${official}`] },
  },
};
const artifacts = join(tmpdir(), "zcode-plugin-mode-order");
for (const [width, locale, theme] of [
  [1200, "en-US", "light"],
  [390, "zh-CN", "dark"],
]) {
  test(`PSO-01/04/06/07/09 ${width}/${locale}/${theme}`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let requests = 0;
    let release;
    let status = 200;
    let body = config;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    await page.route("**/order", async (route) => {
      requests += 1;
      if (requests === 1) await gate;
      await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    });
    const cards = (scope) =>
      scope
        .getByTestId("plugin-store-card")
        .evaluateAll((elements) =>
          elements.map((e) => e.getAttribute("data-plugin-id").split("@")[0]),
        );
    const productSection = () =>
      page
        .locator("section")
        .filter({ has: page.locator('[data-group-key="category:productivity"]') });
    try {
      await page.goto(`${origin}fixture?locale=${locale}&theme=${theme}`);
      await page.getByTestId("plugin-store-list").waitFor();
      // 配置尚未返回，默认分类已经可以展开和浏览。
      assert.deepEqual(await cards(productSection()), ["p0", "p1", "p2", "p3", "p4", "p5"]);
      release();
      await page.waitForFunction(() =>
        document
          .querySelector('[data-group-key="category:productivity"]')
          ?.closest("section")
          ?.querySelector("[data-plugin-id]")
          ?.getAttribute("data-plugin-id")
          ?.startsWith("p7@"),
      );
      assert.deepEqual(await cards(productSection()), ["p7", "p6", "p0", "p1", "p2", "p3"]);
      // 第一块是精选，其固定名单没有受排序配置影响。
      const sections = () =>
        page.locator("section").filter({ has: page.getByTestId("plugin-store-card") });
      assert.deepEqual(await cards(sections().nth(0)), ["p1", "p0"]);
      assert.deepEqual(await cards(sections().nth(1)), ["dev"]);
      await productSection().getByTestId("plugin-store-group-toggle").click();
      assert.deepEqual(await cards(productSection()), [
        "p7",
        "p6",
        "p0",
        "p1",
        "p2",
        "p3",
        "p4",
        "p5",
      ]);
      await page.getByTestId("work").click();
      assert.deepEqual(await cards(sections().nth(1)), ["other"]);
      assert.deepEqual(await cards(productSection()), [
        "p5",
        "p4",
        "p0",
        "p1",
        "p2",
        "p3",
        "p6",
        "p7",
      ]);
      assert.deepEqual(await cards(sections().nth(0)), ["p1", "p0"]);
      assert.equal(requests, 1);
      assert.equal(
        await page.evaluate(() => localStorage.getItem("zcode-interface-mode")),
        "general",
      );
      // 个人与全量搜索继续按各自原来的名称顺序。
      await page.getByTestId("plugin-store-segment-personal").click();
      assert.deepEqual(await cards(page), ["personal-a", "personal-b"]);
      await page.getByTestId("code").click();
      assert.deepEqual(await cards(page), ["personal-a", "personal-b"]);
      await page.getByTestId("plugin-store-search").fill("p");
      const searchOrder = await cards(page);
      await page.getByTestId("work").click();
      assert.deepEqual(await cards(page), searchOrder);
      await page.getByTestId("plugin-store-search").fill("");
      await page.getByTestId("plugin-store-segment-public").click();
      // 失败刷新保留现有投影，成功撤销则恢复默认顺序。
      status = 503;
      const failed = page.waitForResponse((response) => response.url().endsWith("/order"));
      await page.getByTestId("refresh").click();
      await failed;
      assert.deepEqual(await cards(sections().nth(1)), ["other"]);
      status = 200;
      body = null;
      await page.getByTestId("refresh").click();
      await page.waitForFunction(() =>
        document
          .querySelector('[data-group-key="category:productivity"]')
          ?.closest("section")
          ?.querySelector("[data-plugin-id]")
          ?.getAttribute("data-plugin-id")
          ?.startsWith("p0@"),
      );
      assert.deepEqual(await cards(sections().nth(1)), [
        "p0",
        "p1",
        "p2",
        "p3",
        "p4",
        "p5",
        "p6",
        "p7",
      ]);
      assert.equal(requests, 3);
      const categoryTitles = await page.locator("section h2").allTextContents();
      assert.equal(categoryTitles.includes(locale === "zh-CN" ? "指南" : "Guides"), false);
      assert.equal(categoryTitles.includes(locale === "zh-CN" ? "法律" : "Legal"), false);
      const legacyCategory = await page
        .locator(
          '[data-testid="plugin-store-card"][data-plugin-id="legacy-guide@zcode-plugins-official"]',
        )
        .evaluate((element) => element.closest("section").querySelector("h2").textContent);
      assert.equal(legacyCategory, locale === "zh-CN" ? "实用工具" : "Utilities");
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      assert.deepEqual(errors, []);
      await mkdir(artifacts, { recursive: true });
      await page.screenshot({
        path: join(artifacts, `${width}-${locale}-${theme}.png`),
        fullPage: true,
      });
      // 仅测试目录加入一条未来法律插件；当前真实目录仍没有法律插件。
      body = config;
      await page.goto(`${origin}fixture?locale=${locale}&theme=${theme}&legal=1`);
      const legalCard = page.locator(
        '[data-testid="plugin-store-card"][data-plugin-id="legal-example@zcode-plugins-official"]',
      );
      await legalCard.waitFor();
      assert.equal(
        await legalCard.evaluate(
          (element) => element.closest("section").querySelector("h2").textContent,
        ),
        locale === "zh-CN" ? "法律" : "Legal",
      );
      await page.waitForFunction(() => {
        const sections = Array.from(document.querySelectorAll("section")).filter((s) =>
          s.querySelector('[data-testid="plugin-store-card"]'),
        );
        return (
          sections[1]?.querySelector("[data-plugin-id]")?.getAttribute("data-plugin-id") ===
          "legal-example@zcode-plugins-official"
        );
      });
      assert.deepEqual(errors, []);
      // 退出市场的官方插件即使已安装、被精选或仍在旧目录中也不可见；个人同名插件保留。
      await page.goto(`${origin}fixture?locale=${locale}&theme=${theme}&retired=1`);
      await page.getByTestId("plugin-store-list").waitFor();
      const retired = page.locator(`[data-plugin-id="restore-legacy-sessions@${official}"]`);
      for (const mode of ["code", "work"]) {
        await page.getByTestId(mode).click();
        assert.equal(await retired.count(), 0);
        assert.equal(await page.getByTestId("plugin-store-installed-strip").count(), 0);
        await page.getByTestId("plugin-store-search").fill("restore-legacy-sessions");
        assert.equal(await retired.count(), 0);
        assert.equal(await page.getByTestId("plugin-store-card").count(), 1);
        assert.equal(
          await page.getByTestId("plugin-store-card").getAttribute("data-plugin-id"),
          "restore-legacy-sessions@personal",
        );
        await page.getByTestId("plugin-store-search").fill("");
      }
      await page.getByTestId("plugin-store-segment-personal").click();
      assert.equal(
        await page
          .locator(
            '[data-testid="plugin-store-card"][data-plugin-id="restore-legacy-sessions@personal"]',
          )
          .count(),
        1,
      );
      assert.deepEqual(errors, []);
    } finally {
      release();
      await page.close();
    }
  });
}

for (const width of [1200, 390]) {
  for (const locale of ["en-US", "zh-CN"]) {
    for (const theme of ["light", "dark"]) {
      test(`PLM-MISSING-CONFIG ${width}/${locale}/${theme}`, async () => {
        const page = await browser.newPage({ viewport: { width, height: 900 } });
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        try {
          await page.route("**/order", (route) => route.fulfill({ json: config }));
          await page.goto(`${origin}fixture?missingConfig=1&locale=${locale}&theme=${theme}`);
          const card = (name) =>
            page.locator(`[data-testid="plugin-store-card"][data-plugin-id="${name}@${official}"]`);
          await card("documents").waitFor();
          assert.equal(await card("document-skills").count(), 0);
          for (const name of ["documents", "pdf", "presentations", "spreadsheets", "image-search"])
            assert.equal(await card(name).count(), 1, name);
          assert.equal(
            await card("repairable")
              .getByRole("button", { name: locale === "zh-CN" ? "安装" : "Install", exact: true })
              .count(),
            1,
          );
          const bundledIcons = [
            ["plugin-creator", "plugin-creator.png"],
            ["documents", "documents.png"],
            ["pdf", "pdf.png"],
            ["presentations", "presentations.png"],
            ["spreadsheets", "spreadsheets.png"],
            ["image-search", "image-search.png"],
          ];
          await Promise.all(bundledIcons.map(([name]) => card(name).locator("img").waitFor()));
          await page.waitForFunction(() => {
            const images = document.querySelectorAll(
              '[data-plugin-id$="@zcode-plugins-official"] img',
            );
            return [...images].every((image) => image.complete && image.naturalWidth > 0);
          });
          for (const [name, assetName] of bundledIcons)
            assert.match(
              await card(name).locator("img").getAttribute("src"),
              new RegExp(assetName),
            );
          await mkdir(artifacts, { recursive: true });
          await page.screenshot({
            path: join(artifacts, `missing-config-${width}-${locale}-${theme}.png`),
          });
          await page.getByRole("searchbox").fill("document-skills");
          assert.equal(await page.getByTestId("plugin-store-card").count(), 0);
          assert.deepEqual(errors, []);
        } finally {
          await page.close();
        }
      });
    }
  }
}

for (const width of [1200, 390]) {
  for (const locale of ["en-US", "zh-CN"]) {
    for (const theme of ["light", "dark"]) {
      test(`PLM-DOCUMENT-ORDER ${width}/${locale}/${theme}`, async () => {
        const page = await browser.newPage({ viewport: { width, height: 900 } });
        try {
          await page.route("**/order", (route) => route.fulfill({ json: null }));
          await page.goto(`${origin}fixture?documentOrder=1&locale=${locale}&theme=${theme}`);
          await page.getByTestId("plugin-store-installed-item").first().waitFor();
          const expected = ["pdf", "presentations", "spreadsheets", "documents"].map(
            (name) => `${name}@${official}`,
          );
          for (const mode of ["code", "work"]) {
            await page.getByTestId(mode).click();
            for (const testId of ["plugin-store-installed-item", "plugin-store-card"]) {
              const ids = await page
                .getByTestId(testId)
                .evaluateAll((elements) =>
                  elements.slice(0, 4).map((element) => element.getAttribute("data-plugin-id")),
                );
              assert.deepEqual(ids, expected);
            }
          }
          await mkdir(artifacts, { recursive: true });
          await page.screenshot({
            path: join(artifacts, `document-order-${width}-${locale}-${theme}.png`),
          });
        } finally {
          await page.close();
        }
      });
    }
  }
}
