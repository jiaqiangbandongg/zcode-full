import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
const entry =
  "/packages/ui/test/browser/manual-review/pending/provider-family-responsive.fixture.tsx";
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

for (const width of [320, 390, 430, 650, 1200]) {
  for (const locale of ["en-US", "zh-CN"]) {
    for (const theme of ["light", "dark"]) {
      test(`连接方式布局与交互 ${width}/${locale}/${theme}`, async () => {
        const page = await browser.newPage({ viewport: { width, height: 800 } });
        page.setDefaultTimeout(10_000);
        page.on("pageerror", (error) => console.error(error));
        try {
          for (const panel of width === 1200 ? [430, 1000] : [width]) {
            for (const name of [
              "北京智谱华章科技股份有限公司",
              "研发",
              "International Research and Development Team",
              "InternationalResearchAndDevelopmentOrganization".repeat(3),
            ]) {
              const query = new URLSearchParams({ locale, theme, name, panel: String(panel) });
              await page.goto(`${origin}fixture?${query}`);
              const trigger = page.getByRole("combobox");
              await trigger.waitFor();
              assert.equal(
                await page.getByTestId("model-provider-start-plan-switch-prefix").count(),
                0,
                "不再独立显示 Switch to",
              );
              if (name.startsWith("北京")) {
                const shortcut = page.getByTestId("model-provider-start-plan-count-shortcut");
                await shortcut.hover();
                const tooltip = page.getByRole("tooltip");
                await tooltip.waitFor();
                assert.equal(
                  await tooltip.textContent(),
                  locale === "zh-CN" ? "切换至体验套餐" : "Switch to Start Plan",
                );
                await page.keyboard.press("Escape");
                await tooltip.waitFor({ state: "hidden" });
                await page.mouse.move(0, 0);
                await shortcut.focus();
                await tooltip.waitFor();
                await page.keyboard.press("Escape");
                await tooltip.waitFor({ state: "hidden" });
              }
              await page.evaluate(() => document.fonts.ready);
              const geometry = await trigger.evaluate((el) => {
                const rect = el.getBoundingClientRect();
                const panelRect = document
                  .querySelector('[data-testid="panel"]')
                  .getBoundingClientRect();
                const arrow = el.querySelector("svg").getBoundingClientRect();
                const shortcut = document
                  .querySelector('[data-testid="model-provider-start-plan-count-shortcut"]')
                  .getBoundingClientRect();
                const panelStyle = getComputedStyle(
                  document.querySelector('[data-testid="panel"]'),
                );
                const heading = document.querySelector("h3").parentElement.getBoundingClientRect();
                const controls = el.parentElement.getBoundingClientRect();
                const value = el.querySelector('[data-slot="select-value"]');
                return {
                  left: rect.left,
                  right: rect.right,
                  top: rect.top,
                  bottom: rect.bottom,
                  panelRight: panelRect.right,
                  controlWidth: rect.width,
                  controlsWidth: controls.width,
                  headingWidth: heading.width,
                  headingTop: heading.top,
                  headingBottom: heading.bottom,
                  shortcutGroupWidth: shortcut.width,
                  availableWidth:
                    panelRect.width -
                    parseFloat(panelStyle.paddingLeft) -
                    parseFloat(panelStyle.paddingRight),
                  arrowRight: arrow.right,
                  arrowLeft: arrow.left,
                  shortcutTop: shortcut.top,
                  shortcutBottom: shortcut.bottom,
                  textOverflow: getComputedStyle(value.firstElementChild ?? value).textOverflow,
                  textWidth: (value.firstElementChild ?? value).clientWidth,
                  fullTextWidth: (value.firstElementChild ?? value).scrollWidth,
                  chromeWidth: rect.width - value.getBoundingClientRect().width,
                  scrollWidth: document.documentElement.scrollWidth,
                };
              });
              console.log(JSON.stringify({ width, panel, locale, theme, geometry }));
              assert.ok(geometry.right <= geometry.panelRight, "选择框超出面板");
              assert.ok(geometry.scrollWidth <= width, "页面横向溢出");
              assert.ok(
                geometry.arrowRight <= geometry.right && geometry.arrowLeft >= geometry.left,
                "箭头被裁切",
              );
              assert.equal(geometry.textOverflow, "ellipsis");
              if (geometry.availableWidth >= geometry.headingWidth + 256 + 8) {
                assert.ok(
                  geometry.shortcutTop < geometry.headingBottom &&
                    geometry.shortcutBottom > geometry.headingTop,
                  "标题右侧有空间时操作区必须同行，不能因团队全称过长而整组换行",
                );
              }
              if (panel === 1000 && name === "International Research and Development Team") {
                assert.ok(
                  geometry.fullTextWidth <= geometry.textWidth + 1,
                  "宽屏有空间时应显示全称，不受 288px 上限截断",
                );
              }
              if (geometry.fullTextWidth > geometry.textWidth + 1) {
                const remaining = geometry.controlsWidth - geometry.shortcutGroupWidth - 8;
                if (remaining >= 48)
                  assert.ok(
                    geometry.controlWidth >= remaining - 1,
                    "截断名称前应先使用当前行剩余空间",
                  );
              }
              if (name === "研发") assert.ok(geometry.controlWidth < 100, "短名称不拉满成空白长框");
              if (48 + geometry.shortcutGroupWidth + 8 > geometry.controlsWidth)
                assert.ok(geometry.top >= geometry.shortcutBottom, "空间不足时自然换行");
              else
                assert.ok(
                  geometry.top < geometry.shortcutBottom && geometry.bottom > geometry.shortcutTop,
                  "实际空间足够时保持横排，不受旧 576px 断点强制换行",
                );

              if (
                process.env.RESPONSIVE_SCREENSHOT_PATH &&
                width === Number(process.env.RESPONSIVE_SCREENSHOT_WIDTH ?? 390) &&
                locale === "en-US" &&
                theme === "dark" &&
                name === (process.env.RESPONSIVE_SCREENSHOT_NAME ?? "北京智谱华章科技股份有限公司")
              ) {
                await page.screenshot({
                  path: process.env.RESPONSIVE_SCREENSHOT_PATH,
                  clip: await page.getByTestId("panel").boundingBox(),
                });
              }
              await trigger.click();
              const team = page.getByRole("option", { name, exact: true });
              await team.waitFor();
              const menu = await page.getByRole("listbox").boundingBox();
              assert.ok(menu.x >= 0 && menu.x + menu.width <= width + 1, "菜单超出视口");
              assert.ok(
                await team.evaluate((el) => el.scrollWidth <= el.clientWidth),
                "菜单全称被截断",
              );
              await page
                .getByRole("option", {
                  name: locale === "zh-CN" ? "体验套餐" : "Start Plan",
                  exact: true,
                })
                .click();
              assert.equal(await page.getByTestId("selected").textContent(), "start");
              await trigger.click();
              await page.getByRole("option", { name, exact: true }).click();
              assert.equal(await page.getByTestId("selected").textContent(), "team");
              await page.getByTestId("model-provider-start-plan-count-shortcut").click();
              assert.equal(await page.getByTestId("selected").textContent(), "start");
            }
          }
        } finally {
          await page.close();
        }
      });
    }
  }
}
