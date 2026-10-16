import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
const entry = "/packages/ui/test/browser/manual-review/pending/sidebar-user-id.fixture.tsx";
const artifacts = "/tmp/zcode-sidebar-user-id";
let server, browser, origin;
before(async () => {
  await mkdir(artifacts, { recursive: true });
  server = await createServer({
    root,
    configFile: false,
    plugins: [
      {
        name: "footer-fixture-boundaries",
        load(id) {
          if (id.endsWith("/hooks/usePlatform.tsx"))
            return "export const usePlatform=()=>({executeDesktopCommand:async()=>{}});";
          if (id.endsWith("/rewards/RewardsProvider.tsx"))
            return "export const useOpenRewards=()=>()=>{};";
          if (id.endsWith("/shortcuts/useShortcutBindings.ts"))
            return 'export const useShortcutCommandLabel=()=>"";';
          if (id.endsWith("/store/StoreProvider.tsx"))
            return 'export const useZCodeStore=(select)=>select({interfaceMode:"coding",setInterfaceMode:()=>{},isRestoringOAuthSession:false});';
          if (id.endsWith("/WorkspaceWebRemoteControlTrigger.tsx"))
            return "export const WorkspaceWebRemoteControlTrigger=()=>null;";
          if (id.endsWith("/WorkspaceSidebarFooterUsageSummary.tsx"))
            return 'import React from "react"; export const useWorkspaceSidebarFooterUsageSummaryState=()=>({}); export const WorkspaceSidebarFooterPlanBadge=()=>React.createElement("span",{className:"rounded-full border border-border bg-surface px-1 py-px text-ui-xs text-foreground-subtle"},"Pro"); export const WorkspaceSidebarFooterUsageSummaryContent=()=>null;';
        },
      },
      react(),
      tailwindcss(),
      {
        name: "footer-page",
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
  browser = await chromium.launch({ channel: "chrome" });
});
after(async () => {
  await browser?.close();
  await server?.close();
});

async function open(params = {}, clipboard = "ok", width = 960) {
  const page = await browser.newPage({ viewport: { width, height: 680 } });
  await page.addInitScript((mode) => {
    window.copiedValues = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value:
        mode === "missing"
          ? undefined
          : {
              writeText: async (value) => {
                if (mode === "reject") throw new Error("denied");
                window.copiedValues.push(value);
              },
            },
    });
  }, clipboard);
  await page.goto(`${origin}fixture?${new URLSearchParams(params)}`);
  const trigger = page.getByRole("button", {
    name: params.guest === "1" ? "连接使用" : "Alex",
    exact: true,
  });
  await trigger.waitFor();
  assert.equal(await trigger.getByText("Pro", { exact: true }).count(), 0);
  await trigger.click();
  return page;
}
for (const theme of ["light", "dark"])
  for (const mobile of ["0", "1"]) {
    test(`展示、复制与主题 ${theme} mobile=${mobile}`, async () => {
      const page = await open({ theme, mobile }, "ok", mobile === "1" ? 390 : 960);
      try {
        const item = page.getByTestId("copy-user-id");
        await item.waitFor();
        assert.equal(
          await page.getByRole("menuitem", { name: "界面缩放", exact: true }).count(),
          mobile === "1" ? 0 : 1,
        );
        assert.equal(
          await page.getByTestId("profile-menu-id").innerText(),
          "ID: 12345678901234567890",
        );
        await page.getByTestId("profile-menu-id").click();
        assert.deepEqual(await page.evaluate(() => window.copiedValues), []);
        await page.mouse.move(0, 0);
        assert.equal(
          await item.evaluate((el) => getComputedStyle(el).backgroundColor),
          "rgba(0, 0, 0, 0)",
        );
        await item.hover();
        await page.waitForFunction(
          () =>
            getComputedStyle(document.querySelector('[data-testid="copy-user-id"]'))
              .backgroundColor !== "rgba(0, 0, 0, 0)",
        );
        await page.mouse.move(0, 0);

        const header = page.getByTestId("profile-menu-header");
        assert.equal(await header.locator('[data-testid="profile-menu-name"]').innerText(), "Alex");
        assert.equal(await header.locator('[data-slot="avatar"]').count(), 1);
        const geometry = await header.evaluate((el) => {
          const name = el
            .querySelector('[data-testid="profile-menu-name"]')
            .getBoundingClientRect();
          const id = el.querySelector('[data-testid="profile-menu-id"]').getBoundingClientRect();
          const copy = el.querySelector('[data-testid="copy-user-id"]').getBoundingClientRect();
          const plan = el
            .querySelector('[data-testid="profile-menu-plan"]')
            .getBoundingClientRect();
          return {
            copyGap: copy.x - id.right,
            planGap: plan.x - name.right,
            nameX: name.x,
            idX: id.x,
            nameBottom: name.bottom,
            idTop: id.top,
            first: el.parentElement.firstElementChild === el,
          };
        });
        assert.equal(geometry.nameX, geometry.idX);
        assert.ok(geometry.idTop >= geometry.nameBottom);
        assert.ok(geometry.first);
        assert.ok(geometry.copyGap >= 0 && geometry.copyGap <= 8);
        assert.ok(geometry.planGap >= 0 && geometry.planGap <= 8);
        assert.equal(await header.getByTestId("profile-menu-plan").innerText(), "Pro");
        await page
          .getByRole("menu")
          .screenshot({ path: `${artifacts}/${theme}-${mobile}.png`, animations: "disabled" });
        await item.click();
        await page.getByText("用户 ID 已复制", { exact: true }).waitFor();
        assert.deepEqual(await page.evaluate(() => window.copiedValues), ["12345678901234567890"]);
      } finally {
        await page.close();
      }
    });
  }
test("长 ID 截断、英文和键盘复制", async () => {
  const id = "user-" + "1234567890".repeat(10);
  const page = await open({ id, locale: "en-US", mobile: "1" }, "ok", 390);
  try {
    const item = page.getByTestId("copy-user-id");
    await item.waitFor();
    const rect = await item.boundingBox();
    assert.ok(rect.x >= 0 && rect.x + rect.width <= 390);
    assert.ok(
      await page.getByTestId("profile-menu-id").evaluate((el) => el.scrollWidth > el.clientWidth),
    );
    await item.focus();
    await page.keyboard.press("Enter");
    await page.getByText("User ID copied", { exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.copiedValues), [id]);
  } finally {
    await page.close();
  }
});
for (const params of [{ guest: "1" }, { id: "" }])
  test(`无 ID 隐藏 ${JSON.stringify(params)}`, async () => {
    const page = await open(params);
    try {
      assert.equal(await page.getByTestId("copy-user-id").count(), 0);
    } finally {
      await page.close();
    }
  });
for (const mode of ["reject", "missing"])
  test(`复制失败 ${mode}`, async () => {
    const page = await open({}, mode);
    try {
      await page.getByTestId("copy-user-id").click();
      await page.getByText("复制失败，请重试", { exact: true }).waitFor();
      assert.deepEqual(await page.evaluate(() => window.copiedValues), []);
      assert.equal(await page.getByText("用户 ID 已复制", { exact: true }).count(), 0);
    } finally {
      await page.close();
    }
  });
