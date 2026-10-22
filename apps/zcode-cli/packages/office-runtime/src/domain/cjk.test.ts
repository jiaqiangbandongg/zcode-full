import { describe, expect, it } from "vitest";
import { normalizeCjkCompat } from "#office/domain/cjk.ts";

describe("normalizeCjkCompat", () => {
  it("maps radicals that PDF producers emit for ideographs back to the ideographs", () => {
    // Chrome 打印的 PDF：文→⽂(U+2F42)、方→⽅(U+2F45)、玄→⽞(U+2F5E)、黑→⿊(U+2FCA)、黄→⻩(U+2EE9)。
    expect(normalizeCjkCompat("苹⽅：中⽂排版，天地⽞⻩，冬青⿊体")).toBe(
      "苹方：中文排版，天地玄黄，冬青黑体",
    );
  });

  it("covers every Kangxi radical and the supplement entries with an equivalent ideograph", () => {
    for (let code = 0x2f00; code <= 0x2fd5; code++) {
      const out = normalizeCjkCompat(String.fromCodePoint(code));
      expect(out.codePointAt(0)).toBeGreaterThanOrEqual(0x3400);
    }
    expect(normalizeCjkCompat("⺟⻳")).toBe("母龟");
  });

  it("keeps full-width punctuation, Latin text and the UTF-16 length", () => {
    const text = "（全角）：“引号”，ＡＢＣ abc 123。";
    expect(normalizeCjkCompat(text)).toBe(text);
    const mixed = "a⽂b⻩c";
    expect(normalizeCjkCompat(mixed)).toHaveLength(mixed.length);
  });
});
