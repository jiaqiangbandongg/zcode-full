import { describe, expect, it } from "vitest";
import { describeAt, strings } from "#ui/i18n.ts";
import { nextZoom } from "#ui/viewers/types.ts";

describe("describeAt", () => {
  const t = strings("en-US");
  it("says locators the way people do", () => {
    expect(describeAt("page:3", t)).toBe("Page 3");
    expect(describeAt("page:2-4", t)).toBe("Pages 2–4");
    expect(describeAt("page:4", t, true)).toBe("page 4");
    expect(describeAt("slide:2/shape:7", t)).toBe("Slide 2 · Shape");
    expect(describeAt("p:12", t)).toBe("Paragraph 12");
    expect(describeAt("t:1/r3c1", t)).toBe("Table 1 · R3C1");
    expect(describeAt("Plan!C2:D2", t)).toBe("Plan · C2:D2");
    expect(describeAt("'Q3 data'!A1", t)).toBe("Q3 data · A1");
    expect(describeAt("'Q3 data'", t)).toBe("Q3 data");
  });
  it("has Chinese labels", () => {
    expect(describeAt("page:3", strings("zh-CN"))).toBe("第 3 页");
  });
});

describe("strings", () => {
  // The default profile opens every format.
  it("names every format the plugin opens", () => {
    expect(strings("en").emptyCaption).toContain(".docx, .xlsx, .pptx or .pdf");
    expect(strings("en").openFile).toBe("Open file");
    expect(strings("en").errors.unsupported_type[1]).toBe(
      "Office opens .docx, .xlsx, .pptx and .pdf files.",
    );
    expect(strings("zh-CN").emptyCaption).toContain(".docx、.xlsx、.pptx 或 .pdf");
    expect(strings("zh-CN").openFile).toBe("打开文件");
  });
});

describe("nextZoom", () => {
  it("steps through the zoom ladder within 25–400%", () => {
    expect(nextZoom(100, 1)).toBe(110);
    expect(nextZoom(100, -1)).toBe(90);
    expect(nextZoom(117, 1)).toBe(125);
    expect(nextZoom(400, 1)).toBe(400);
    expect(nextZoom(25, -1)).toBe(25);
  });
});

describe("tool wording", () => {
  it("names every format for the default profile", async () => {
    const wording = await import("#office/wording.ts");
    expect(wording.FILE_NOUN).toBe("an Office or PDF file");
    expect(wording.FILES_NOUN).toBe("Office and PDF files");
    expect(wording.EXAMPLE_ANCHORS).toBe(
      "report.docx#p:12, model.xlsx#Revenue!B2:F9, deck.pptx#slide:3, paper.pdf#page:5",
    );
    expect(wording.TARGET_NOUNS).toBe("paragraph, cell range, slide, shape or page");
    expect(wording.QUOTE_BEST_FOR).toBe("PDF pages and long paragraphs");
    expect(wording.CAPTURE_EXAMPLES).toBe(
      "deck.pptx#slide:3, paper.pdf#page:2, report.docx#p:12 or model.xlsx#Revenue!A1:H30",
    );
  });
});
