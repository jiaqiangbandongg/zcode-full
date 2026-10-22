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
const entry = "/packages/ui/test/browser/manual-review/pending/new-task-rendering.fixture.tsx";
const artifacts = join(root, "packages/desktop/.e2e-artifacts/sidebar-tooltips");
let server, browser, origin;
before(async () => {
  await mkdir(artifacts, { recursive: true });
  server = await createServer({
    root,
    configFile: false,
    plugins: [
      {
        name: "sidebar-tooltip-fixture",
        enforce: "pre",
        load(id) {
          if (id.endsWith("/hooks/useWorkspaceServices.tsx"))
            return "export const useBaseWorkspaceServices=()=>window.__renderFixture.services; export const useWorkspaceServicesResolution=()=>({}); export const useOptionalBaseWorkspaceServices=useBaseWorkspaceServices; export const useWorkspaceServices=useBaseWorkspaceServices;";
          if (id.endsWith("/store/TabStoreProvider.tsx"))
            return "export const useTabStoreApi=()=>window.__renderFixture.tabStore; export const useTabStore=s=>s(window.__renderFixture.tabStore.getState()); export const useOptionalTabStore=useTabStore;";
          if (id.endsWith("/store/StoreProvider.tsx"))
            return "const state={setTheme:()=>{},interfaceMode:'coding'}; export const useZCodeStore=s=>s(state); export const useZCodeStoreWithDefault=(_s,value)=>value;";
          if (id.endsWith("/hooks/usePlatform.tsx"))
            return "export const useOptionalPlatform=()=>null; export const usePlatform=()=>({}); export const useSelectDirectory=()=>async()=>null;";
          if (id.endsWith("/hooks/useConfirmDialog.ts"))
            return "const confirm=async()=>true; export const useConfirmDialog=()=>confirm;";
          if (id.endsWith("/hooks/useWebRemoteControlStatus.ts"))
            return "export const useWebRemoteControlStatus=()=>({mobileConnected:false});";
          if (id.endsWith("/v4/useWorkspaceSessionsIndexItems.ts"))
            return "const result={items:[]}; export const useWorkspaceSessionsIndexItems=()=>result;";
          if (id.endsWith("/settings/CodingPlanUpgradeDialogProvider.tsx"))
            return "export const useCodingPlanUpgradeDialog=()=>({openCodingPlanUpgrade:()=>{}}); export const useOptionalCodingPlanUpgradeDialog=()=>null;";
          if (id.endsWith("/WorkspaceSidebarFooter.tsx"))
            return "export const WorkspaceSidebarFooter=()=>null;";
          if (id.endsWith("/shortcuts/useShortcutBindings.ts"))
            return "export const useShortcutCommandLabel=()=>'';";
        },
        configureServer(vite) {
          vite.middlewares.use(async (req, res, next) => {
            if (!req.url?.startsWith("/fixture?") && !req.url?.startsWith("/details?"))
              return next();
            const fixtureEntry = req.url.startsWith("/details?")
              ? entry.replace("new-task-rendering", "sidebar-tooltip-details")
              : entry;
            res.setHeader("Content-Type", "text/html");
            res.end(
              await vite.transformIndexHtml(
                req.url,
                `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1" /></head><body><div id="root"></div><script type="module" src="${fixtureEntry}"></script></body></html>`,
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
  browser = await chromium.launch({ channel: "chrome" });
});
after(async () => {
  await browser?.close();
  await server?.close();
});

// 记录真实 pointermove 到可见提示挂载的间隔，避免把 WebDriver 往返耗时当成产品延迟。
async function hoverTiming(page, target) {
  await target.evaluate((element) => {
    window.__tooltipTiming = null;
    element.addEventListener(
      "pointermove",
      () => {
        const start = performance.now();
        const observer = new MutationObserver(() => {
          const tooltip = document.querySelector(
            '[data-slot="tooltip-content"][data-state$="open"]',
          );
          if (!tooltip) return;
          window.__tooltipTiming = {
            elapsed: performance.now() - start,
            text: tooltip.textContent,
          };
          observer.disconnect();
        });
        observer.observe(document.body, { childList: true, subtree: true });
        window.__tooltipObserver?.disconnect();
        window.__tooltipObserver = observer;
      },
      { once: true },
    );
  });
  await target.hover();
  await page.waitForFunction(() => window.__tooltipTiming !== null);
  return page.evaluate(() => window.__tooltipTiming);
}

for (const width of [390, 1200])
  for (const theme of ["light", "dark"])
    for (const locale of ["zh-CN", "en-US"])
      test(`SBT01/02/04 ${width}/${theme}/${locale}`, { timeout: 60000 }, async () => {
        const page = await browser.newPage({ viewport: { width, height: 800 } });
        page.setDefaultTimeout(10000);
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        try {
          await page.goto(
            `${origin}fixture?tooltips=1&theme=${theme}&locale=${locale}&mobile=${width === 390 ? 1 : 0}`,
          );
          const project = page.locator('[data-project-id="p0"]');
          await project.waitFor();
          await project.getByTestId("virtual-project-row").hover();
          const targets = [
            project.getByTestId("virtual-project-menu"),
            project.getByTestId("virtual-project-files"),
            project.getByTestId("virtual-project-create-task").locator(".."),
            page.getByTestId("virtual-project-add"),
            page.getByTestId("virtual-project-new-task"),
            page.getByTestId("sidebar-search-open"),
            page.getByTestId("sidebar-view-menu"),
          ];
          const timings = [];
          for (const target of targets) {
            // 相邻按钮之间直接移动，验证上一条提示打开后也不能跳过 300ms。
            console.log("hover", target.toString());
            const timing = await hoverTiming(page, target);
            console.log(timing);
            assert.ok(
              timing.elapsed >= 275,
              `tooltip appeared too early: ${JSON.stringify(timing)}`,
            );
            assert.ok(
              timing.elapsed < 1500,
              `tooltip appeared too late: ${JSON.stringify(timing)}`,
            );
            assert.ok(timing.text.trim());
            timings.push(timing);
          }
          await page.screenshot({ path: join(artifacts, `${width}-${theme}-${locale}.png`) });
          await page.mouse.move(width - 1, 799);
          await page.waitForTimeout(350);
          const search = page.getByTestId("sidebar-search-open");
          await search.hover();
          await page.waitForTimeout(100);
          assert.equal(await page.locator('[data-slot="tooltip-content"]').count(), 0);
          await page.mouse.move(width - 1, 799);
          await page.waitForTimeout(350);
          assert.equal(await page.locator('[data-slot="tooltip-content"]').count(), 0);
          // 点击分区新建仍通过真实导航进入草稿，不等待 Tooltip。
          await page.getByTestId("virtual-project-new-task").click();
          await page.waitForFunction(
            () => document.querySelector('[data-testid="current-task"]').textContent === "draft",
          );
          assert.deepEqual(errors, []);
          await writeFile(
            join(artifacts, `${width}-${theme}-${locale}.json`),
            JSON.stringify({ timings, errors }, null, 2),
          );
        } catch (error) {
          await page.screenshot({ path: join(artifacts, "failure.png") });
          console.log(
            await page.locator('[data-slot="tooltip-content"]').allTextContents(),
            errors,
          );
          throw error;
        } finally {
          await page.close();
        }
      });

for (const width of [390, 1200])
  for (const theme of ["light", "dark"])
    test(`SBT03 native/grouped ${width}/${theme}`, { timeout: 60000 }, async () => {
      const page = await browser.newPage({
        viewport: { width, height: 800 },
        hasTouch: width === 390,
      });
      page.setDefaultTimeout(10000);
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      try {
        await page.goto(`${origin}details?theme=${theme}`);
        await page.getByTestId("native-menu").waitFor();
        assert.equal(await page.getByTestId("details-sidebar").locator("[title]").count(), 0);
        assert.equal(
          await page.getByTestId("outside-native").getAttribute("title"),
          "Outside native",
        );
        const timings = [];
        for (const target of [
          page.getByTestId("native-menu"),
          page.getByTestId("disabled-native").locator(".."),
          page.getByTestId("nested-tooltip"),
          page.getByText("Draft folder", { exact: true }),
          page.getByText("Grouped task", { exact: true }),
        ]) {
          const timing = await hoverTiming(page, target);
          assert.ok(timing.elapsed >= 275 && timing.elapsed < 1500, JSON.stringify(timing));
          timings.push(timing);
        }
        const groupedFiles = page.getByRole("button", { name: "Show file tree", exact: true });
        const groupedAction = await hoverTiming(page, groupedFiles);
        assert.ok(
          groupedAction.elapsed >= 275 && groupedAction.elapsed < 1500,
          JSON.stringify(groupedAction),
        );
        assert.match(groupedAction.text, /Show file tree/);
        await page.waitForTimeout(100);
        assert.match(
          await page.locator('[data-slot="tooltip-content"][data-state$="open"]').textContent(),
          /Show file tree/,
        );
        timings.push(groupedAction);
        await page.mouse.move(width - 1, 799);
        await page.waitForTimeout(350);
        const outside = await hoverTiming(page, page.getByTestId("outside-tooltip"));
        assert.ok(outside.elapsed < 275, JSON.stringify(outside));
        const menu = page.getByTestId("native-menu");
        if (width === 390) await menu.tap();
        else await menu.click();
        await page.getByRole("menuitem", { name: "Open folder" }).click();
        assert.equal(
          await page.getByTestId("clicks").textContent(),
          "2",
          "asChild must preserve both trigger and child handlers",
        );
        await page.mouse.move(width - 1, 799);
        await page.waitForTimeout(350);
        await menu.focus();
        await page.waitForFunction(() =>
          document
            .querySelector('[data-slot="tooltip-content"]')
            ?.textContent?.includes("File menu"),
        );
        assert.deepEqual(errors, []);
        await page.screenshot({ path: join(artifacts, `details-${width}-${theme}.png`) });
        await writeFile(
          join(artifacts, `details-${width}-${theme}.json`),
          JSON.stringify({ timings, outside, errors }, null, 2),
        );
      } catch (error) {
        console.log(errors);
        await page.screenshot({ path: join(artifacts, "details-failure.png") });
        throw error;
      } finally {
        await page.close();
      }
    });
