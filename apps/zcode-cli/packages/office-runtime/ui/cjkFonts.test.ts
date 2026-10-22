import { describe, expect, it } from "vitest";
import { cjkFamilies, classifyFontName, withCjkFamilies } from "#ui/cjkFonts.ts";

/** pdf.js 把字体名的原始字节逐个当作 Latin-1 字符保存（TextEncoder 只有 UTF-8，样例字节写死）。 */
const bytes = (...codes: number[]) => String.fromCharCode(...codes);
const NAMES = {
  宋体: bytes(0xcb, 0xce, 0xcc, 0xe5), // GBK
  黑体: bytes(0xba, 0xda, 0xcc, 0xe5), // GBK
  楷体: bytes(0xbf, 0xac, 0xcc, 0xe5), // GBK
  仿宋: bytes(0xb7, 0xc2, 0xcb, 0xce), // GBK
  標楷體: bytes(0xbc, 0xd0, 0xb7, 0xa2, 0xc5, 0xe9), // Big5
  "ＭＳ 明朝": bytes(0x82, 0x6c, 0x82, 0x72, 0x20, 0x96, 0xbe, 0x92, 0xa9), // Shift-JIS
};

describe("classifyFontName", () => {
  it.each([
    ["SimSun", "sc", "serif"],
    ["ABCDEF+SimHei", "sc", "sans"],
    ["STSong-Light", "sc", "serif"],
    ["STSongStd-Light", "sc", "serif"],
    ["Microsoft YaHei", "sc", "sans"],
    ["KaiTi_GB2312", "sc", "kai"],
    ["FangSong", "sc", "fang"],
    ["FZShuSong-Z01", "sc", "serif"],
    ["MSung-Light", "tc", "serif"],
    ["MingLiU", "tc", "serif"],
    ["DFKai-SB", "tc", "kai"],
    ["HeiseiMin-W3", "jp", "serif"],
    ["HeiseiKakuGo-W5", "jp", "sans"],
    ["MS-Mincho", "jp", "serif"],
    ["KozGoPr6N-Medium", "jp", "sans"],
    ["HYSMyeongJo-Medium", "kr", "serif"],
    ["HYGoThic-Medium", "kr", "sans"],
    ["Batang", "kr", "serif"],
  ])("%s → %s %s", (name, script, style) => {
    expect(classifyFontName(name)).toEqual({ script, style });
  });

  it("decodes multi-byte font names", () => {
    expect(classifyFontName(NAMES.宋体)).toEqual({ script: "sc", style: "serif" });
    expect(classifyFontName(NAMES.黑体)).toEqual({ script: "sc", style: "sans" });
    expect(classifyFontName(NAMES.楷体)).toEqual({ script: "sc", style: "kai" });
    expect(classifyFontName(NAMES.仿宋)).toEqual({ script: "sc", style: "fang" });
    expect(classifyFontName(NAMES.標楷體)).toEqual({ script: "tc", style: "kai" });
    expect(classifyFontName(NAMES["ＭＳ 明朝"])).toEqual({ script: "jp", style: "serif" });
  });

  it("knows nothing about Latin fonts", () => {
    expect(classifyFontName("Arial")).toBeNull();
    expect(classifyFontName("ABCDEF+Calibri-Bold")).toBeNull();
  });
});

describe("cjkFamilies", () => {
  const font = (name: string, fallbackName = "sans-serif") => ({
    name,
    fallbackName,
    missingFile: true,
  });

  it("leaves embedded and Type 3 fonts alone", () => {
    expect(cjkFamilies({ name: "SimSun", missingFile: false }, false)).toEqual([]);
    expect(cjkFamilies({ name: "SimSun", missingFile: true, isType3Font: true }, false)).toEqual(
      [],
    );
  });

  it("uses the name first, then the PDF's serif flag, Simplified Chinese by default", () => {
    expect(cjkFamilies(font("SimSun"), false)).toEqual(["zcode-cjk-sc-serif"]);
    expect(cjkFamilies(font("Unknown", "serif"), false)).toEqual(["zcode-cjk-sc-serif"]);
    expect(cjkFamilies(font("Unknown"), false)).toEqual(["zcode-cjk-sc-sans"]);
    expect(cjkFamilies(font("HeiseiMin-W3"), false)).toEqual(["zcode-cjk-jp-serif"]);
  });

  it("falls back from kai / fang to the serif face, then to the bundled font", () => {
    expect(cjkFamilies(font("KaiTi"), true)).toEqual([
      "zcode-cjk-sc-kai",
      "zcode-cjk-sc-serif",
      "zcode-cjk-fallback",
    ]);
  });
});

describe("withCjkFamilies", () => {
  it("inserts the families before the trailing generic family", () => {
    expect(withCjkFamilies('"SimSun",g_d0_s1,sans-serif', ["zcode-cjk-sc-serif"])).toBe(
      '"SimSun",g_d0_s1,"zcode-cjk-sc-serif",sans-serif',
    );
    expect(withCjkFamilies('"g_d0_f2", serif', ["zcode-cjk-sc-serif"])).toBe(
      '"g_d0_f2","zcode-cjk-sc-serif",serif',
    );
  });

  it("appends when the chain has no generic family", () => {
    expect(withCjkFamilies('"SimSun",g_d0_s1', ["zcode-cjk-sc-serif"])).toBe(
      '"SimSun",g_d0_s1,"zcode-cjk-sc-serif"',
    );
  });

  it("returns the chain unchanged without families", () => {
    expect(withCjkFamilies('"g_d0_f1", sans-serif', [])).toBe('"g_d0_f1", sans-serif');
  });
});
