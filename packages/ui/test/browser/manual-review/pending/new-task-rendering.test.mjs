import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
const entry = "/packages/ui/test/browser/manual-review/pending/new-task-rendering.fixture.tsx";
const artifacts = join(root, "packages/desktop/.e2e-artifacts/new-task-rendering");
let server, browser, origin;
before(async () => {
  await mkdir(artifacts, { recursive: true });
  server = await createServer({
    root,
    configFile: false,
    plugins: [
      {
        name: "new-task-fixture-boundaries",
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
            return "import {useSyncExternalStore} from 'react'; export const useWorkspaceSessionsIndexItems=()=>useSyncExternalStore(window.__renderFixture.activityStore.subscribe,window.__renderFixture.activityStore.getSnapshot);";
          if (id.endsWith("/settings/CodingPlanUpgradeDialogProvider.tsx"))
            return "export const useCodingPlanUpgradeDialog=()=>({openCodingPlanUpgrade:()=>{}}); export const useOptionalCodingPlanUpgradeDialog=()=>null;";
          if (id.endsWith("/WorkspaceSidebarFooter.tsx"))
            return "export const WorkspaceSidebarFooter=()=>null;";
          if (id.endsWith("/shortcuts/useShortcutBindings.ts"))
            return "export const useShortcutCommandLabel=()=>'';";
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
  browser = await chromium.launch({ channel: "chrome" });
});
after(async () => {
  await browser?.close();
  await server?.close();
});

for (const mobile of [false, true])
  for (const theme of ["light", "dark"])
    test(
      `SPT03 new task ${mobile ? "mobile" : "desktop"}/${theme}`,
      { timeout: 60000 },
      async () => {
        const page = await browser.newPage({
          viewport: { width: mobile ? 430 : 1200, height: 800 },
        });
        page.setDefaultTimeout(10000);
        const errors = [];
        page.on("pageerror", (e) => errors.push(String(e)));
        await page.addInitScript(() => {
          window.__projectRenders = 0;
          window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
            supportsFiber: true,
            inject: () => 1,
            onCommitFiberUnmount: () => {},
            onPostCommitFiberRoot: () => {},
            onCommitFiberRoot(_id, root) {
              const walk = (f) => {
                if (!f) return;
                const type = f.elementType || f.type;
                const name = typeof type === "function" ? type.name : type?.type?.name;
                if (f.flags & 1 && name === "ProjectNodeContent") window.__projectRenders++;
                walk(f.child);
                walk(f.sibling);
              };
              walk(root.current);
            },
          };
        });
        const settle = () =>
          page.evaluate(
            () =>
              new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
          );
        try {
          await page.goto(`${origin}fixture?theme=${theme}&mobile=${mobile ? 1 : 0}`);
          await page.locator('[data-project-id="p43"]').waitFor({ state: "attached" });
          await settle();
          const initial = await page.evaluate(() => window.__projectRenders);
          assert.ok(initial >= 44, "React probe must observe initial project renders");
          await page.evaluate(() => {
            window.__projectRenders = 0;
          });
          await page.getByTestId("shell-update").click();
          await settle();
          const shellRenders = await page.evaluate(() => window.__projectRenders);
          await page.evaluate(() => {
            window.__projectRenders = 0;
          });
          await page.getByTestId("task-new-button").click();
          await page.waitForFunction(
            () => document.querySelector('[data-testid="current-task"]').textContent === "draft",
          );
          await settle();
          const newTaskRenders = await page.evaluate(() => window.__projectRenders);
          await page.evaluate(() => {
            window.__projectRenders = 0;
          });
          await page.getByTestId("refresh-directory").click();
          await page.waitForFunction(
            () => document.querySelector('[data-testid="refresh-count"]').textContent === "1",
          );
          await settle();
          const refreshRenders = await page.evaluate(() => window.__projectRenders);
          await page.getByTestId("rename-project").click();
          await page.getByText("Renamed project", { exact: true }).waitFor();
          const evidence = { mobile, theme, initial, shellRenders, newTaskRenders, refreshRenders };
          await writeFile(
            join(artifacts, `${mobile}-${theme}.json`),
            JSON.stringify(evidence, null, 2),
          );
          console.log(evidence);
          await page.screenshot({ path: join(artifacts, `${mobile}-${theme}.png`) });
          assert.deepEqual(errors, []);
          assert.equal(shellRenders, 0, "Unrelated Root render must not redraw projects");
          assert.equal(newTaskRenders, 0, "Local task selection must not redraw project content");
          assert.equal(refreshRenders, 0, "Equivalent directory refresh must not redraw projects");
        } finally {
          await page.close();
        }
      },
    );

for (const mobile of [false, true])
  for (const theme of ["light", "dark"])
    test(
      `SPT06 running activity ${mobile ? "mobile" : "desktop"}/${theme}`,
      { timeout: 60000 },
      async () => {
        const page = await browser.newPage({
          viewport: { width: mobile ? 430 : 1200, height: 800 },
        });
        const errors = [];
        page.on("pageerror", (error) => errors.push(String(error)));
        await page.addInitScript(() => {
          const seen = new WeakMap();
          window.__projectRendersById = {};
          window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
            supportsFiber: true,
            inject: () => 1,
            onCommitFiberUnmount() {},
            onCommitFiberRoot(_id, root) {
              const walk = (fiber) => {
                if (!fiber) return;
                const type = fiber.elementType || fiber.type;
                const name = typeof type === "function" ? type.name : type?.type?.name;
                if (name === "ProjectNodeContent") {
                  const previous = seen.get(fiber) ?? seen.get(fiber.alternate);
                  if (fiber.flags & 1 && previous !== fiber.actualStartTime) {
                    const id = fiber.memoizedProps.project.id;
                    window.__projectRendersById[id] = (window.__projectRendersById[id] ?? 0) + 1;
                  }
                  seen.set(fiber, fiber.actualStartTime);
                  if (fiber.alternate) seen.set(fiber.alternate, fiber.actualStartTime);
                }
                walk(fiber.child);
                walk(fiber.sibling);
              };
              walk(root.current);
            },
          };
        });
        try {
          await page.goto(`${origin}fixture?theme=${theme}&mobile=${mobile ? 1 : 0}&activity=1`);
          await page.locator('[data-project-id="p43"]').waitFor({ state: "attached" });
          const project = page.locator('[data-project-id="p0"]');
          await project.locator(".lucide-loader").waitFor();
          await page.getByTestId("fixture-chat-loading").waitFor();
          const animationState = () =>
            page.evaluate(() =>
              document
                .getAnimations()
                .filter((animation) => animation.animationName === "spin")
                .map((animation) => ({
                  time: animation.currentTime,
                  target: animation.effect.target.tagName.toLowerCase(),
                  transform: getComputedStyle(animation.effect.target).transform,
                })),
            );
          // 真实 Chromium 合成层回归：旋转必须保持加速；样式重算次数仅留作证据，避免时间阈值受机器影响。
          const cdp = await page.context().newCDPSession(page);
          let layers = [];
          cdp.on("LayerTree.layerTreeDidChange", (event) => {
            layers = event.layers ?? [];
          });
          await cdp.send("LayerTree.enable");
          await cdp.send("Performance.enable");
          await page.waitForTimeout(300);
          const metricsBefore = Object.fromEntries(
            (await cdp.send("Performance.getMetrics")).metrics.map((metric) => [
              metric.name,
              metric.value,
            ]),
          );
          await page.waitForTimeout(750);
          const metricsAfter = Object.fromEntries(
            (await cdp.send("Performance.getMetrics")).metrics.map((metric) => [
              metric.name,
              metric.value,
            ]),
          );
          const animationBefore = await animationState();
          await page.waitForTimeout(150);
          const animationAfter = await animationState();
          assert.equal(animationBefore.length, 2);
          assert.equal(animationAfter.length, 2);
          for (let index = 0; index < 2; index++) {
            assert.ok(animationAfter[index].time > animationBefore[index].time);
            assert.notEqual(animationAfter[index].transform, animationBefore[index].transform);
          }
          const styleRecalculations =
            metricsAfter.RecalcStyleCount - metricsBefore.RecalcStyleCount;
          console.log({ mobile, theme, animationAfter, styleRecalculations });
          const { root: documentNode } = await cdp.send("DOM.getDocument");
          const { nodeIds } = await cdp.send("DOM.querySelectorAll", {
            nodeId: documentNode.nodeId,
            selector:
              '[data-project-id="p0"] .animate-spin, [data-testid="fixture-chat-loading"] .animate-spin',
          });
          assert.equal(nodeIds.length, 2);
          const compositorReasons = [];
          for (const nodeId of nodeIds) {
            const { node } = await cdp.send("DOM.describeNode", { nodeId });
            const layer = layers.find(
              (candidate) => candidate.backendNodeId === node.backendNodeId,
            );
            assert.ok(layer, "Each spinner must have a composited layer");
            const { compositingReasonIds } = await cdp.send("LayerTree.compositingReasons", {
              layerId: layer.layerId,
            });
            assert.ok(
              compositingReasonIds.includes("ActiveTransformAnimation"),
              "Spinner rotation must run as an accelerated transform animation",
            );
            compositorReasons.push(compositingReasonIds);
          }
          await writeFile(
            join(artifacts, `animation-${mobile}-${theme}.json`),
            JSON.stringify({ animationAfter, styleRecalculations, compositorReasons }, null, 2),
          );
          await cdp.detach();
          await page.screenshot({ path: join(artifacts, `loading-${mobile}-${theme}.png`) });
          await page.waitForFunction(
            () => document.querySelector('[data-testid="activity-version"]').textContent === "1",
          );
          await page.evaluate(() => {
            window.__projectRendersById = {};
          });
          for (let index = 2; index <= 7; index++) {
            await page.getByTestId("activity-tick").click();
            await page.waitForFunction(
              (value) =>
                document.querySelector('[data-testid="activity-version"]').textContent ===
                String(value),
              index,
            );
          }
          const renders = await page.evaluate(() => window.__projectRendersById);
          await writeFile(
            join(artifacts, `activity-${mobile}-${theme}.json`),
            JSON.stringify({ mobile, theme, renders }, null, 2),
          );
          console.log({ mobile, theme, activityRenders: renders });
          assert.ok(renders.p0 >= 6, "Each real activity update reaches the affected project");
          assert.deepEqual(
            Object.keys(renders),
            ["p0"],
            "Activity must not render unrelated project content",
          );
          await page.getByTestId("activity-complete").click();
          await project.locator(".lucide-loader").waitFor({ state: "detached" });
          await page.getByTestId("fixture-chat-loading").waitFor({ state: "detached" });
          await page.getByTestId("change-task").click();
          await project.getByText("Renamed task", { exact: true }).waitFor();
          await project.getByTestId("virtual-project-toggle").click();
          await project.getByTestId("virtual-project-unread").waitFor();
          await project.getByTestId("virtual-project-toggle").click();
          await page.getByTestId("rename-project").click();
          await project.getByText("Renamed project", { exact: true }).waitFor();
          await project.getByTestId("virtual-project-menu").click();
          await page.getByTestId("virtual-project-pin").click();
          await project
            .locator('[data-testid="virtual-project-toggle"] .lucide-pin')
            .waitFor({ state: "attached" });
          await project.getByTestId("virtual-project-menu").click();
          await page.getByTestId("virtual-project-pin").click();
          await project
            .locator('[data-testid="virtual-project-toggle"] .lucide-pin')
            .waitFor({ state: "detached" });
          await page.screenshot({ path: join(artifacts, `activity-${mobile}-${theme}.png`) });
          assert.deepEqual(errors, []);
        } finally {
          await page.close();
        }
      },
    );
