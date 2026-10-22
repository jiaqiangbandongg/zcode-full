import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
const entry = "/packages/ui/test/browser/manual-review/pending/share-failure.fixture.tsx";
const artifacts = join(tmpdir(), "share-failure-errors-0921");
let server, browser, origin;
before(async () => {
  await mkdir(artifacts, { recursive: true });
  server = await createServer({
    root,
    configFile: false,
    plugins: [
      react(),
      tailwindcss(),
      {
        name: "share-selection-fixture",
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

const messages = {
  invalid_contract: [/接口异常（HTTP 405）/, /returned HTTP 405/],
  network: [/中断或超时/, /interrupted or timed out/],
  safety_check_rejected: [/内容未通过安全检查/, /Content did not pass/],
  safety_check_unavailable: [/安全检查服务暂不可用/, /safety check service is unavailable/],
  service_unavailable: [/分享服务暂时异常/, /sharing service is temporarily unavailable/],
  invalid_conversation: [/所选对话/, /selected conversation/i],
  expired: [/分享准备已过期/, /Share preparation expired/],
};
for (const kind of Object.keys(messages))
  for (const width of [390, 1200])
    for (const theme of ["light", "dark"])
      for (const locale of ["zh-CN", "en-US"])
        test(`SHARE33 ${kind} ${width} ${theme} ${locale}`, async () => {
          const page = await browser.newPage({ viewport: { width, height: 900 } });
          const errors = [];
          page.on("pageerror", (error) => errors.push(String(error)));
          await page.goto(`${origin}fixture?kind=${kind}&theme=${theme}&locale=${locale}`);
          const message = page.getByTestId("conversation-share-error-message");
          await message.waitFor();
          assert.match(await message.innerText(), messages[kind][locale === "zh-CN" ? 0 : 1]);
          await page.getByTestId("conversation-share-request-id-trigger").click();
          const details = page.getByTestId("conversation-share-request-id-content");
          await details.waitFor();
          const text = await details.innerText();
          for (const id of ["server-request-33", "client-request-33", "share-operation-33"])
            assert.ok(text.includes(id));
          if (kind === "invalid_conversation") {
            assert.ok(text.includes("rows[0].state"));
            assert.ok(text.includes("field_type"));
            assert.ok(text.includes("3205"));
          }
          if (kind === "safety_check_rejected") assert.ok(text.includes("3216"));
          if (kind === "safety_check_unavailable") assert.ok(text.includes("3217"));
          await page.evaluate(async () => {
            await Promise.all(
              document.getAnimations().map((animation) => animation.finished.catch(() => {})),
            );
          });
          await page.screenshot({
            path: join(artifacts, `${kind}-${width}-${theme}-${locale}.png`),
            fullPage: true,
          });
          await page.keyboard.press("Escape");
          await page.getByTestId("conversation-share-confirm").click();
          assert.equal(await page.getByTestId("attempts").innerText(), "1");
          assert.ok((await page.getByText("9 / 9", { exact: false }).count()) > 0);
          assert.deepEqual(errors, []);
          await page.close();
        });

for (const width of [390, 1200])
  for (const theme of ["light", "dark"])
    for (const locale of ["zh-CN", "en-US"])
      test(`SHARE34 preflight auth ${width} ${theme} ${locale}`, async () => {
        const page = await browser.newPage({ viewport: { width, height: 900 } });
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(
          `${origin}fixture?surface=preflight&kind=authentication_required&theme=${theme}&locale=${locale}`,
        );
        await page.getByTestId("conversation-share-selection-preflight-status").click();
        const popover = page.getByTestId("conversation-share-selection-preflight-popover");
        await popover.waitFor();
        const text = await popover.innerText();
        assert.match(
          text,
          locale === "zh-CN" ? /请先登录 ZCode/ : /Sign in to ZCode before sharing/,
        );
        assert.match(text, locale === "zh-CN" ? /暂时无法检查分享/ : /Unable to check this share/);
        assert.doesNotMatch(
          text,
          /原因未知|cause could not|during —|内容无法分享|Some content cannot/,
        );
        assert.equal(await page.getByTestId("conversation-share-next").isDisabled(), true);
        await page.getByTestId("conversation-share-preflight-retry").click();
        assert.equal(await page.getByTestId("attempts").innerText(), "1");
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
          false,
        );
        assert.deepEqual(errors, []);
        await page.screenshot({
          path: join(artifacts, `preflight-auth-${width}-${theme}-${locale}.png`),
          fullPage: true,
        });
        await page.close();
      });
