import { describe, expect, it } from "vitest";
import { buildCsvTableText } from "@/components/ai-elements/markdown-table.js";

describe("buildCsvTableText", () => {
  it("为中文 CSV 添加 UTF-8 BOM，避免 Excel 按本地代码页误解码", () => {
    const csv = buildCsvTableText([
      ["姓名", "城市"],
      ["张三", "北京"],
    ]);

    expect(csv).toBe("\uFEFF姓名,城市\r\n张三,北京");
    expect(Array.from(new TextEncoder().encode(csv).slice(0, 3))).toEqual([
      0xef,
      0xbb,
      0xbf,
    ]);
  });

  it("添加 BOM 时保留 CSV 转义与公式注入防护", () => {
    expect(
      buildCsvTableText([
        ["名称", "值"],
        ["示例", '=HYPERLINK("https://example.com","打开")'],
      ]),
    ).toBe(
      '\uFEFF名称,值\r\n示例,"\'=HYPERLINK(""https://example.com"",""打开"")"',
    );
  });
});
