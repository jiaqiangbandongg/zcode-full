import { describe, expect, it } from "vitest";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

import { createPdfJsDocumentOptions } from "@/lib/pdfJsAssets.js";
import { listPdfJsCMapAssets, resolvePdfJsCMapsDirectory } from "../vite/pdfJsCMapsPlugin.js";

const REPORTLAB_STSONG_PDF_BASE64 =
  "JVBERi0xLjQKJZOMi54gUmVwb3J0TGFiIEdlbmVyYXRlZCBQREYgZG9jdW1lbnQgKG9wZW5zb3VyY2UpCjEgMCBvYmoKPDwKL0YxIDIgMCBSIC9GMiAzIDAgUgo+PgplbmRvYmoKMiAwIG9iago8PAovQmFzZUZvbnQgL0hlbHZldGljYSAvRW5jb2RpbmcgL1dpbkFuc2lFbmNvZGluZyAvTmFtZSAvRjEgL1N1YnR5cGUgL1R5cGUxIC9UeXBlIC9Gb250Cj4+CmVuZG9iagozIDAgb2JqCjw8Ci9CYXNlRm9udCAvU1RTb25nLUxpZ2h0IC9EZXNjZW5kYW50Rm9udHMgWyA8PAovQmFzZUZvbnQgL1NUU29uZy1MaWdodCAvQ0lEU3lzdGVtSW5mbyA8PAovT3JkZXJpbmcgKEdCMSkgL1JlZ2lzdHJ5IChBZG9iZSkgL1N1cHBsZW1lbnQgMAo+PiAvRFcgMTAwMCAvRm9udERlc2NyaXB0b3IgPDwKL0FzY2VudCA3NTIgL0NhcEhlaWdodCA3MzcgL0Rlc2NlbnQgLTI3MSAvRmxhZ3MgNiAvRm9udEJCb3ggWyAtMjUgLTI1NCAxMDAwIDg4MCBdIC9Gb250TmFtZSAvU1RTb25nU3RkLUxpZ2h0IAogIC9JdGFsaWNBbmdsZSAwIC9MZWFkaW5nIDE0OCAvTWF4V2lkdGggMTAwMCAvTWlzc2luZ1dpZHRoIDUwMCAvU3RlbUggOTEgL1N0ZW1WIDU4IAogIC9UeXBlIC9Gb250RGVzY3JpcHRvciAvWEhlaWdodCA1NTMKPj4gL1N1YnR5cGUgL0NJREZvbnRUeXBlMCAvVHlwZSAvRm9udCAKICAvVyBbIDEgWyAyMDcgMjcwIDM0MiA0NjcgNDYyIDc5NyA3MTAgMjM5IDM3NCBdIDEwIFsgMzc0IDQyMyA2MDUgMjM4IDM3NSAyMzggMzM0IDQ2MiBdIDE4IDI2IDQ2MiAyNyAyOCAyMzggCiAgMjkgMzEgNjA1IDMyIFsgMzQ0IDc0OCA2ODQgNTYwIDY5NSA3MzkgNTYzIDUxMSA3MjkgNzkzIAogIDMxOCAzMTIgNjY2IDUyNiA4OTYgNzU4IDc3MiA1NDQgNzcyIDYyOCAKICA0NjUgNjA3IDc1MyA3MTEgOTcyIDY0NyA2MjAgNjA3IDM3NCAzMzMgCiAgMzc0IDYwNiA1MDAgMjM5IDQxNyA1MDMgNDI3IDUyOSA0MTUgMjY0IAogIDQ0NCA1MTggMjQxIDIzMCA0OTUgMjI4IDc5MyA1MjcgNTI0IF0gODEgWyA1MjQgNTA0IDMzOCAzMzYgMjc3IDUxNyA0NTAgNjUyIDQ2NiA0NTIgCiAgNDA3IDM3MCAyNTggMzcwIDYwNSBdIF0KPj4gXSAvRW5jb2RpbmcgL1VuaUdCLVVDUzItSCAvTmFtZSAvRjIgL1N1YnR5cGUgL1R5cGUwIC9UeXBlIC9Gb250Cj4+CmVuZG9iago0IDAgb2JqCjw8Ci9Db250ZW50cyA4IDAgUiAvTWVkaWFCb3ggWyAwIDAgNTk1LjI3NTYgODQxLjg4OTggXSAvUGFyZW50IDcgMCBSIC9SZXNvdXJjZXMgPDwKL0ZvbnQgMSAwIFIgL1Byb2NTZXQgWyAvUERGIC9UZXh0IC9JbWFnZUIgL0ltYWdlQyAvSW1hZ2VJIF0KPj4gL1JvdGF0ZSAwIC9UcmFucyA8PAoKPj4gCiAgL1R5cGUgL1BhZ2UKPj4KZW5kb2JqCjUgMCBvYmoKPDwKL1BhZ2VNb2RlIC9Vc2VOb25lIC9QYWdlcyA3IDAgUiAvVHlwZSAvQ2F0YWxvZwo+PgplbmRvYmoKNiAwIG9iago8PAovQXV0aG9yIChaLmFpKSAvQ3JlYXRpb25EYXRlIChEOjIwMjYwNzI4MTUzNDE4KzA4JzAwJykgL0NyZWF0b3IgKFouYWkpIC9LZXl3b3JkcyAoKSAvTW9kRGF0ZSAoRDoyMDI2MDcyODE1MzQxOCswOCcwMCcpIC9Qcm9kdWNlciAoUmVwb3J0TGFiIFBERiBMaWJyYXJ5IC0gXChvcGVuc291cmNlXCkpIAogIC9TdWJqZWN0IChIZWxsbyBXb3JsZCBpbiBFbmdsaXNoLCBDaGluZXNlLCBhbmQgU3BhbmlzaCkgL1RpdGxlIChIZWxsbywgV29ybGQhIC0gVGhyZWUgTGFuZ3VhZ2VzKSAvVHJhcHBlZCAvRmFsc2UKPj4KZW5kb2JqCjcgMCBvYmoKPDwKL0NvdW50IDEgL0tpZHMgWyA0IDAgUiBdIC9UeXBlIC9QYWdlcwo+PgplbmRvYmoKOCAwIG9iago8PAovRmlsdGVyIFsgL0FTQ0lJODVEZWNvZGUgL0ZsYXRlRGVjb2RlIF0gL0xlbmd0aCAzMjYKPj4Kc3RyZWFtCkdhdCVdOWhXQWgmO0taTCgjdURnXT9dYmVFWUt1ZFBfdVtmS2ZyTzM1RW5tOy9OcnNmU1lXKSpkTlVHI1lXTTs5XVlkQm0+aCZKViRLKilDcj9EPjcjVi4jTDFrWzw6NmhaZW04YTM+R2VyZzcnVihlaWdoVyQ/IWo0dWIrIWhIIm9WZVYoOjJhaVc3Y1djTyRnX3ByXSZkSUNgM2thdUAiXGI0MmVPK1NcR0gmNmNMJSMtJSVSdGsoSFs0YmJqQDtsJWFnWl5PJGE6PEJBUVxYNyc1bmRgbVYoU1JGPitYY1VJNW4xWiJQJTxeIT1CZkVyODpOKC9gZidvXzpnOFRASVJcNUtkLlQ4PyhvZik7LD5xUVw0PUdeJDBSaUlrSUokPDJUZWxlMjQvUkBMMUxtPkxtJ3VyTEstaGFGNCsiLzpPL34+ZW5kc3RyZWFtCmVuZG9iagp4cmVmCjAgOQowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwNjEgMDAwMDAgbiAKMDAwMDAwMDEwMiAwMDAwMCBuIAowMDAwMDAwMjA5IDAwMDAwIG4gCjAwMDAwMDExNDIgMDAwMDAgbiAKMDAwMDAwMTM0NSAwMDAwMCBuIAowMDAwMDAxNDEzIDAwMDAwIG4gCjAwMDAwMDE3MjAgMDAwMDAgbiAKMDAwMDAwMTc3OSAwMDAwMCBuIAp0cmFpbGVyCjw8Ci9JRCAKWzw4ZmQxN2JhMWMwMzE1YTNhNGEwN2MxNTE0YzM3OTRkZT48OGZkMTdiYTFjMDMxNWEzYTRhMDdjMTUxNGMzNzk0ZGU+XQolIFJlcG9ydExhYiBnZW5lcmF0ZWQgUERGIGRvY3VtZW50IC0tIGRpZ2VzdCAob3BlbnNvdXJjZSkKCi9JbmZvIDYgMCBSCi9Sb290IDUgMCBSCi9TaXplIDkKPj4Kc3RhcnR4cmVmCjIxOTUKJSVFT0YK";

describe("PDF.js CMap support", () => {
  it("resolves CMap URLs from the active Vite base", () => {
    expect(createPdfJsDocumentOptions("./", "file:///app/out/renderer/index.html")).toEqual({
      cMapPacked: true,
      cMapUrl: "file:///app/out/renderer/pdfjs/cmaps/",
    });
    expect(
      createPdfJsDocumentOptions("/remote/v4/", "https://zcode.example/remote/v4/index.html"),
    ).toEqual({
      cMapPacked: true,
      cMapUrl: "https://zcode.example/remote/v4/pdfjs/cmaps/",
    });
  });

  it("publishes the complete packed CMap set", async () => {
    const assets = await listPdfJsCMapAssets();
    const fileNames = new Set(assets.map((asset) => asset.fileName));

    expect(assets.length).toBeGreaterThan(150);
    expect(fileNames).toContain("pdfjs/cmaps/UniGB-UCS2-H.bcmap");
    expect(fileNames).toContain("pdfjs/cmaps/Adobe-GB1-UCS2.bcmap");
  });

  it("decodes ReportLab STSong text with the bundled CMaps", async () => {
    const data = new Uint8Array(Buffer.from(REPORTLAB_STSONG_PDF_BASE64, "base64"));
    // Bugfix：pdf.js 要求 cMapUrl 以 `/` 结尾（api_utils.js getFactoryUrlProp 会直接抛
    // "must include trailing slash"），这里原来用宿主分隔符补尾，Windows 上补出来的是 `\`，
    // 用例必然失败。cMapUrl 只是拼 `${cMapUrl}${name}.bcmap` 后交给 Node fs 读取，
    // Windows 接受混合分隔符，所以统一补 `/`。
    const cMapUrl = `${resolvePdfJsCMapsDirectory()}/`;
    const loadingTask = pdfjs.getDocument({ data, cMapPacked: true, cMapUrl });
    const document = await loadingTask.promise;

    try {
      const page = await document.getPage(1);
      const textContent = await page.getTextContent();
      expect(textContent.items.map((item) => item.str).join(" ")).toContain("中文: 你好，世界！");
    } finally {
      await document.destroy();
    }
  });
});
