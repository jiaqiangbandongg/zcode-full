import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { chromium } from "playwright-core";

// SPT01：真实 Dev App 的空草稿 + 至少两个项目；只切换面板，不创建任务或请求模型。
// 记录 React commit 而非绝对毫秒门限，避免机器速度和 DevTools 录制影响回归判据。
test(
  "SPT01: side pane toggles do not render unrelated project rows",
  { timeout: 120_000 },
  async () => {
    const connection = await chromium.connectOverCDP(
      process.env.ZCODE_E2E_CDP_URL ?? "http://localhost:9229",
    );
    const page = connection
      .contexts()[0]
      .pages()
      .find((candidate) => /localhost:517/.test(candidate.url()));
    assert.ok(page, "需要已运行的 ZCode Dev");
    const toggle = () => page.getByTestId("side-pane-toggle").filter({ visible: true });
    const originalLabel = await toggle().getAttribute("aria-label");
    const originalClass = await page.locator("html").getAttribute("class");
    const evidence = [];
    try {
      assert.ok((await page.locator("[data-project-id]").count()) >= 2, "需要多个项目的回归场景");
      for (const theme of ["light", "dark"]) {
        await page.locator("html").evaluate((element, value) => {
          element.className = `${value} theme-zai-${value}`;
        }, theme);
        await page.waitForTimeout(500);
        for (let index = 0; index < 4; index++) {
          await toggle().hover();
          await page.waitForTimeout(250);
          await page.evaluate(() => {
            const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
            if (!hook) throw new Error("需要 React Dev 运行时");
            const original = hook.onCommitFiberRoot;
            const sample = {
              start: performance.now(),
              projectRenders: 0,
              sidebarProps: [],
              frames: [],
            };
            const instrumented = function (...args) {
              const walk = (fiber) => {
                if (!fiber) return;
                const type = fiber.elementType || fiber.type;
                const name = typeof type === "function" ? type.name : type?.type?.name;
                if (fiber.flags & 1) {
                  if (name === "ProjectNodeContent") sample.projectRenders++;
                  if (name === "ProjectSidebar")
                    sample.sidebarProps.push(
                      Object.keys(fiber.memoizedProps || {}).filter(
                        (key) =>
                          !Object.is(
                            fiber.memoizedProps[key],
                            fiber.alternate?.memoizedProps?.[key],
                          ),
                      ),
                    );
                }
                walk(fiber.child);
                walk(fiber.sibling);
              };
              walk(args[1].current);
              return original?.apply(this, args);
            };
            hook.onCommitFiberRoot = instrumented;
            const onClick = () => {
              sample.start = performance.now();
              requestAnimationFrame(() => {
                sample.frames.push(performance.now() - sample.start);
                requestAnimationFrame(() => sample.frames.push(performance.now() - sample.start));
              });
            };
            document.addEventListener("click", onClick, { once: true, capture: true });
            window.__panelToggleSample = () => {
              hook.onCommitFiberRoot = original;
              document.removeEventListener("click", onClick, true);
              delete window.__panelToggleSample;
              return sample;
            };
          });
          const label = await toggle().getAttribute("aria-label");
          await toggle().click();
          await page.waitForFunction(
            (before) =>
              [...document.querySelectorAll('[data-testid="side-pane-toggle"]')].some(
                (button) =>
                  button.getBoundingClientRect().width > 0 &&
                  button.getAttribute("aria-label") !== before,
              ),
            label,
          );
          await page.waitForTimeout(700);
          const sample = await page.evaluate(() => window.__panelToggleSample());
          evidence.push({ theme, index, ...sample });
        }
      }
      const artifacts = fileURLToPath(
        new URL("../../../../../desktop/.e2e-artifacts/side-pane-toggle/", import.meta.url),
      );
      await mkdir(artifacts, { recursive: true });
      await writeFile(`${artifacts}/samples.json`, JSON.stringify(evidence, null, 2));
      console.log(JSON.stringify(evidence));
      assert.equal(
        evidence.reduce((sum, sample) => sum + sample.projectRenders, 0),
        0,
      );
      assert.ok(evidence.every((sample) => sample.frames.length === 2));
    } finally {
      await page.evaluate(() => window.__panelToggleSample?.());
      if ((await toggle().getAttribute("aria-label")) !== originalLabel) await toggle().click();
      await page.locator("html").evaluate((element, value) => {
        element.className = value ?? "";
      }, originalClass);
      await connection.close();
    }
  },
);
