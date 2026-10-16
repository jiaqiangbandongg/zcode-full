import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { compile } from "@tailwindcss/node";
import { chromium } from "playwright-core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Plus, Cloud, Settings, Square } from "lucide-react";
import sharp from "sharp";

const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
const artifacts = join(tmpdir(), "zcode-lucide-opacity");
let browser;
let css;
const icon = (className = "", component = Plus) =>
  renderToStaticMarkup(createElement(component, { className, size: 96 }));

before(async () => {
  const compiler = await compile(await readFile(`${root}packages/ui/src/styles.css`, "utf8"), {
    base: `${root}packages/ui/src`,
    onDependency() {},
  });
  css = compiler.build([
    "text-foreground",
    "text-foreground-subtle",
    "text-foreground-subtlest",
    "text-destructive",
    "hover:text-foreground",
    "hover:text-destructive",
    "group-hover:text-foreground",
    "disabled:text-foreground-subtlest",
    "data-[active=true]:text-foreground",
    "opacity-50",
    "opacity-0",
    "text-foreground-subtle/50",
    "fill-current",
    "text-current",
    "focus:text-foreground",
  ]);
  browser = await chromium.launch(
    process.env.CHROME_EXECUTABLE_PATH
      ? { executablePath: process.env.CHROME_EXECUTABLE_PATH }
      : { channel: "chrome" },
  );
  await mkdir(artifacts, { recursive: true });
});
after(async () => {
  await browser?.close();
});

for (const width of [390, 1200]) {
  for (const theme of ["light", "dark"]) {
    test(`Lucide transparency ${width}/${theme}`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 1000 } });
      try {
        const rows = ["var(--color-background)", "var(--color-panel)", "#477e99"]
          .map(
            (background, i) =>
              `<section style="background:${background}">
            <div id="direct-${i}">${icon("text-foreground-subtle")}</div>
            <div id="inherited-${i}" class="text-foreground-subtle">${icon()}<span>文字 Aa</span></div>
            <div id="weak-${i}" class="text-foreground-subtlest">${icon()}</div>
          </section>`,
          )
          .join("");
        await page.setContent(`<html class="theme-zai-${theme}"><head><style>${css}</style>
          <style>body{overflow:auto;background:var(--color-background)!important;color:var(--color-foreground)}section{display:flex;margin:8px}section>div{width:110px}button{display:inline-block}svg{flex-shrink:0}</style></head><body>
          ${rows}
          <button id="hover" class="text-foreground-subtle hover:text-foreground">${icon()}</button>
          <button id="semantic" class="text-foreground-subtle hover:text-destructive">${icon()}</button>
          <div class="text-foreground-subtle" id="override">${icon("text-destructive")}</div>
          <div class="text-foreground-subtle" id="faded">${icon("opacity-50")}</div>
          <div class="text-foreground-subtle" id="hidden">${icon("opacity-0")}</div>
          <div class="group" id="group"><div class="text-foreground-subtle group-hover:text-foreground">${icon()}</div></div>
          <button id="disabled" disabled class="text-foreground disabled:text-foreground-subtlest">${icon()}</button>
          <div id="selected" data-active="true" class="text-foreground-subtle data-[active=true]:text-foreground">${icon()}</div>
          <div id="modifier" class="text-foreground-subtle/50">${icon()}</div>
          <div id="filled" class="text-foreground-subtle">${icon("fill-current", Square)}</div>
          <div id="current" class="text-foreground-subtle">${icon("text-current")}</div>
          <button id="focus" class="text-foreground-subtle focus:text-foreground">${icon()}</button>
          <div class="text-foreground-subtle">${icon("", Cloud)}${icon("", Settings)}</div>
          </body></html>`);
        for (const prefix of ["direct", "inherited", "weak"]) {
          for (let i = 0; i < 3; i++) {
            const buffer = await page.locator(`#${prefix}-${i} svg`).screenshot();
            const { data, info } = await sharp(buffer)
              .removeAlpha()
              .raw()
              .toBuffer({ resolveWithObject: true });
            const pixel = (x, y) => [
              ...data.subarray((y * info.width + x) * 3, (y * info.width + x) * 3 + 3),
            ];
            assert.deepEqual(pixel(48, 48), pixel(32, 48), `${prefix}/${i}: 交点不应加深`);
            // 去掉 Lucide 标记得到原始绘制，比较非交点，防止“全部改成不透明”造成假通过。
            const original = page.locator(`#${prefix}-${i} svg`);
            await original.evaluate((el) => el.classList.remove("lucide"));
            const reference = await sharp(await original.screenshot())
              .removeAlpha()
              .raw()
              .toBuffer();
            const offset = (48 * info.width + 32) * 3;
            const expected = [...reference.subarray(offset, offset + 3)];
            assert.ok(
              pixel(32, 48).every((channel, index) => Math.abs(channel - expected[index]) <= 1),
              "保留非交点的原始混色",
            );
            await original.evaluate((el) => el.classList.add("lucide"));
          }
        }
        const color = (selector) =>
          page.locator(selector).evaluate((el) => getComputedStyle(el).color);
        const textColor = await color("#inherited-0 span");
        assert.equal(textColor, await color("#inherited-0"), "文字颜色应保持继承");
        const beforeHover = await page.locator("#hover svg").screenshot();
        await page.locator("#hover").hover();
        assert.notDeepEqual(await page.locator("#hover svg").screenshot(), beforeHover);
        await page.locator("#semantic").hover();
        assert.equal(await color("#semantic svg"), await color("#override svg"));
        for (const id of ["semantic", "override", "selected"]) {
          assert.equal(
            await page.locator(`#${id} svg`).evaluate((el) => getComputedStyle(el).filter),
            "none",
            `${id}: 清除继承层级`,
          );
        }
        await page.locator("#group").hover();
        assert.equal(
          await page.locator("#group svg").evaluate((el) => getComputedStyle(el).filter),
          "none",
        );
        assert.equal(
          await page.locator("#disabled svg").evaluate((el) => getComputedStyle(el).filter),
          `opacity(${theme === "light" ? "0.4" : "0.3"})`,
        );
        assert.equal(
          await page.locator("#faded svg").evaluate((el) => getComputedStyle(el).opacity),
          "0.5",
        );
        assert.equal(
          await page.locator("#faded svg").evaluate((el) => getComputedStyle(el).filter),
          "opacity(0.6)",
        );
        assert.equal(
          await page.locator("#modifier svg").evaluate((el) => getComputedStyle(el).filter),
          "opacity(0.3)",
        );
        assert.equal(
          await page.locator("#hidden svg").evaluate((el) => getComputedStyle(el).opacity),
          "0",
        );
        const filled = page.locator("#filled svg");
        const filledPixel = async () => {
          const { data, info } = await sharp(await filled.screenshot())
            .removeAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });
          return [...data.subarray((48 * info.width + 48) * 3, (48 * info.width + 48) * 3 + 3)];
        };
        const actualFill = await filledPixel();
        await filled.evaluate((el) => el.classList.remove("lucide"));
        assert.deepEqual(actualFill, await filledPixel(), "fill-current 不应重复淡化");
        await filled.evaluate((el) => el.classList.add("lucide"));
        assert.equal(
          await page.locator("#current svg").evaluate((el) => getComputedStyle(el).filter),
          "opacity(0.6)",
        );
        await page.locator("#focus").focus();
        assert.equal(
          await page.locator("#focus svg").evaluate((el) => getComputedStyle(el).filter),
          "none",
        );
        await page.mouse.move(width - 1, 999);
        await page.screenshot({ path: join(artifacts, `${width}-${theme}.png`), fullPage: true });
      } finally {
        await page.close();
      }
    });
  }
}
