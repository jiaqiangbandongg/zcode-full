import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserWindow } from "electron";

export async function checkFileSummary(
  win: BrowserWindow,
  root: string,
  waitHost: (predicate: string) => Promise<unknown>,
) {
  for (const width of [1100, 390]) {
    win.setSize(width, 820);
    for (const theme of ["light", "dark"]) {
      await win.webContents.executeJavaScript(
        `document.documentElement.className=${JSON.stringify(theme === "dark" ? "dark theme-zai-dark" : "theme-zai-light")}; document.body.className='bg-background text-foreground'`,
      );
      // 先证明普通 HTML 可以正常出现，再验证 visualize 去重，避免空组件假阳性。
      await win.webContents.executeJavaScript("window.showFileSummary('ordinary')");
      await waitHost(
        `document.querySelector('#file-preview-cards')?.textContent.includes('demo.html')`,
      );
      await win.webContents.executeJavaScript("window.showFileSummary('mixed')");
      await waitHost(
        `document.querySelector('#file-summary-panel')?.textContent.includes('1 file changed')`,
      );
      await waitHost(
        `document.querySelector('#file-preview-cards')?.textContent.includes('demo.html')`,
      );
      const text = await win.webContents.executeJavaScript(
        "document.querySelector('#file-summary-fixture').textContent",
      );
      assert.ok(text.includes("+7") && text.includes("-2"));
      assert.ok(!text.includes("+77") && !text.includes("calendar.html"));
      await win.webContents.executeJavaScript(
        "window.summaryTrigger=document.querySelector('#file-summary-panel button'); window.summaryTrigger.focus(); window.summaryTrigger.click()",
      );
      await waitHost(
        `document.querySelector('#file-summary-panel')?.textContent.includes('demo.html')`,
      );
      assert.equal(
        await win.webContents.executeJavaScript(
          "window.summaryTrigger.isConnected && document.activeElement === window.summaryTrigger",
        ),
        true,
      );
      assert.equal(
        await win.webContents.executeJavaScript(
          "document.querySelectorAll('#file-preview-cards [data-zcode-stream-animate]').length",
        ),
        1,
      );
      await win.webContents.executeJavaScript(
        "document.querySelector('#file-summary-fixture').scrollIntoView({block:'center'})",
      );
      await win.webContents.executeJavaScript(`Promise.all(
        document.querySelector('#file-summary-fixture').getAnimations({subtree:true})
          .map(animation => animation.finished.catch(() => {})))`);
      await writeFile(
        join(root, `file-summary-${width}-${theme}.png`),
        (await win.webContents.capturePage()).toPNG(),
      );
      await win.webContents.executeJavaScript("window.showFileSummary('only')");
      await waitHost(`document.querySelector('#file-summary-fixture')?.textContent === ''`);
      assert.ok(
        await win.webContents.executeJavaScript(
          "Boolean(document.querySelector('[data-gen-ui-phase=ready]'))",
        ),
      );
    }
  }
  await win.webContents.executeJavaScript("window.showFileSummary('mixed', true)");
  await waitHost(
    `document.querySelector('#file-summary-panel')?.textContent.includes('1 file changed')`,
  );
  assert.equal(
    await win.webContents.executeJavaScript(
      "document.querySelector('#file-preview-cards').textContent",
    ),
    "",
  );
  await win.webContents.executeJavaScript(
    "window.showFileSummary(null); document.documentElement.className=''; document.body.className=''; document.querySelector('#gen-ui-scroll').scrollTop=0",
  );
  win.setSize(1100, 820);
}
