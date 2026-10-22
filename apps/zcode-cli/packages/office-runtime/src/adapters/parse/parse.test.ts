import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseLocator } from "#office/domain/anchor.ts";
import { parseDocx } from "#office/adapters/parse/docx.ts";
import { parsePptx } from "#office/adapters/parse/pptx.ts";
import { parseXlsx } from "#office/adapters/parse/xlsx.ts";
import { parsePdf } from "#office/adapters/parse/pdf.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const fixture = async (name: string) =>
  new Uint8Array(await readFile(join(root, "fixtures", name)));
// 按模块解析定位 pdfjs-dist：仓库使用 hoisted node_modules，包目录下不一定有自己的 node_modules。
const pdfjs = `${dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"))}/`;
const assets = { cMapUrl: `${pdfjs}cmaps/`, standardFontDataUrl: `${pdfjs}standard_fonts/` };

describe("parsers", () => {
  it("reads docx blocks, headings and tables", async () => {
    const doc = await parseDocx(await fixture("report.docx"), "report.docx");
    expect(doc.title).toBe("Quarterly Report");
    expect(doc.outline.map((item) => item.label)).toEqual([
      "Quarterly Report",
      "Revenue",
      "Outlook",
      "Appendix",
    ]);
    const all = doc.read(null, 0).text;
    expect(all).toContain("[p:1] # Quarterly Report");
    expect(all).toContain("| Region | Revenue |");
    expect(all).toContain("- Risk item 1");
    expect(doc.read(parseLocator("docx", "t:1/r2c2"), 0).text).toContain("120");
    expect(doc.search("growth", 5).map((hit) => hit.at)).toEqual(["p:6"]);
    expect(doc.search("South", 5)[0].at).toBe("t:1/r3c1");
    expect(doc.blocks?.[3]).toEqual({
      at: "p:4",
      text: "Revenue grew by 12 percent compared with the previous quarter.",
    });
    expect(() => doc.read(parseLocator("docx", "p:999"), 0)).toThrow(/does not exist/);
  });

  it("reads pptx slides, shapes and notes", async () => {
    const doc = await parsePptx(await fixture("launch.pptx"), "launch.pptx");
    expect(doc.units).toBe(3);
    expect(doc.outline.map((item) => item.label)).toEqual(["Product Launch", "Timeline", "Budget"]);
    const slide2 = doc.read(parseLocator("pptx", "slide:2"), 0).text;
    expect(slide2).toContain("## Slide 2: Timeline");
    expect(slide2).toContain("十一月：复盘");
    expect(slide2).toContain("Speaker notes: Mention the beta feedback numbers.");
    const owner = doc.search("Dana", 5);
    expect(owner).toHaveLength(1);
    expect(doc.read(parseLocator("pptx", owner[0].at), 0).text).toContain("Owner: Dana");
    expect(doc.read(parseLocator("pptx", "slide:3"), 0).text).toContain("| Ads | 40k | Lee |");
  });

  it("reads xlsx ranges with formulas", async () => {
    const doc = await parseXlsx(await fixture("budget.xlsx"), "budget.xlsx");
    expect(doc.outline.map((item) => item.at)).toEqual(["Revenue", "Notes"]);
    const range = doc.read(parseLocator("xlsx", "Revenue!A1:E3"), 0).text;
    expect(range).toContain("| 2 | North | 100 | 110 | 120 |");
    expect(range).toContain("E2: =SUM(B2:D2)");
    expect(doc.read(null, 0).text).toContain("Merged cells: A7:E7");
    expect(doc.search("east", 5).map((hit) => hit.at)).toEqual(["Revenue!A4"]);
    expect(() => doc.check(parseLocator("xlsx", "Missing!A1"))).toThrow(/Sheets: Revenue, Notes/);
  });

  it("reads pdf pages, outline and CJK text", async () => {
    const doc = await parsePdf(await fixture("paper.pdf"), "paper.pdf", assets);
    expect(doc.units).toBe(2);
    expect(doc.title).toBe("Research Paper");
    expect(doc.outline).toEqual([
      { at: "page:1", label: "Introduction", level: 1 },
      { at: "page:2", label: "Method", level: 1 },
    ]);
    expect(doc.read(parseLocator("pdf", "page:1"), 0).text).toContain("缓存显著降低延迟");
    expect(doc.search("cache sizes", 5)).toEqual([
      { at: "page:2", snippet: expect.stringContaining("three cache sizes") },
    ]);
  });

  it("reads non-embedded CJK fonts and maps ToUnicode radicals back to ideographs", async () => {
    const doc = await parsePdf(await fixture("cjk.pdf"), "cjk.pdf", assets);
    const text = doc.read(parseLocator("pdf", "page:1"), 0).text;
    expect(text).toContain("宋体：中文排版测试");
    expect(text).toContain("黑体名称：中文排版测试");
    // ToUnicode 写的是 ⽞(U+2F5E) ⻩(U+2EE9) ⽂(U+2F42)，Chrome 打印的 PDF 常见。
    expect(text).toContain("天地玄黄，中文排版");
    expect(text).not.toMatch(/[⺀-⿟]/);
    expect(doc.search("文", 10)).toHaveLength(4);
    expect(doc.search("玄黄", 5)).toEqual([
      { at: "page:1", snippet: expect.stringContaining("天地玄黄") },
    ]);
  });
});
