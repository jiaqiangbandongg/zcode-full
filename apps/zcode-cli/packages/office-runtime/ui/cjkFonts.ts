/**
 * 未嵌入 CJK 字体的字体链（纯函数部分；注册与加载见 cjkFontRuntime.ts，规格见
 * docs/plugins/2026-10-15-office-viewer-builtin-panels-spec.md §5）。
 *
 * pdf.js 对未嵌入字体只找同名系统字体，找不到就退回通用 serif / sans-serif：宋体被画成黑体，
 * GBK 等多字节字体名直接放弃替换。这里按字体名（含多字节解码）与 PDF 的 Serif 标志选出同类的
 * `zcode-cjk-<文种>-<字形>` 字体族，插进 pdf.js 字体链的通用族之前。
 */

export type CjkScript = "sc" | "tc" | "jp" | "kr";
export type CjkStyle = "serif" | "sans" | "kai" | "fang";

export interface CjkProfile {
  script: CjkScript;
  /** null when the name says nothing about the style; the PDF's serif flag decides. */
  style: CjkStyle | null;
}

/** The parts of a pdf.js font object the chain needs. */
export interface PdfFontLike {
  name?: string;
  fallbackName?: string;
  missingFile?: boolean;
  isType3Font?: boolean;
}

export const FALLBACK_FAMILY = "zcode-cjk-fallback";
/** Manifest of the bundled fallback font, written by scripts/build.mjs for the pdf plugin. */
export const FALLBACK_MANIFEST = "cjk-fallback.json";

/** CJK characters and full-width punctuation only, so Latin text keeps its own fallback. */
export const CJK_UNICODE_RANGE =
  "U+1100-11FF, U+2E80-2FDF, U+2FF0-303F, U+3040-30FF, U+3100-31FF, U+3200-33FF, U+3400-4DBF, " +
  "U+4E00-9FFF, U+A960-A97F, U+AC00-D7FF, U+F900-FAFF, U+FE10-FE1F, U+FE30-FE4F, U+FF00-FFEF, " +
  "U+20000-2FA1F";

/**
 * local() candidates per face: macOS, Windows and Linux fonts, by full name and PostScript name.
 * The first installed one wins; a face with none installed is not registered.
 */
export const LOCAL_FONTS = {
  "sc-serif": [
    "STSongti-SC-Regular",
    "Songti SC Regular",
    "STSong",
    "SimSun",
    "NSimSun",
    "Noto Serif CJK SC",
    "NotoSerifCJKsc-Regular",
    "Noto Serif SC",
    "NotoSerifSC-Regular",
    "Source Han Serif SC",
    "SourceHanSerifSC-Regular",
    "AR PL UMing CN",
    "AR PL SungtiL GB",
  ],
  "sc-sans": [
    "PingFangSC-Regular",
    "PingFang SC Regular",
    "HiraginoSansGB-W3",
    "Hiragino Sans GB W3",
    "STHeitiSC-Light",
    "Heiti SC Light",
    "Microsoft YaHei",
    "SimHei",
    "Noto Sans CJK SC",
    "NotoSansCJKsc-Regular",
    "Noto Sans SC",
    "NotoSansSC-Regular",
    "Source Han Sans SC",
    "SourceHanSansSC-Regular",
    "WenQuanYi Micro Hei",
    "WenQuanYi Zen Hei",
  ],
  "sc-kai": [
    "STKaitiSC-Regular",
    "Kaiti SC Regular",
    "STKaiti",
    "KaiTi",
    "KaiTi_GB2312",
    "AR PL UKai CN",
    "LXGW WenKai",
    "LXGWWenKai-Regular",
  ],
  "sc-fang": ["STFangsong", "FangSong", "FangSong_GB2312"],
  "tc-serif": [
    "STSongti-TC-Regular",
    "Songti TC Regular",
    "LiSongPro",
    "LiSong Pro",
    "PMingLiU",
    "MingLiU",
    "Noto Serif CJK TC",
    "NotoSerifCJKtc-Regular",
    "Noto Serif TC",
    "Source Han Serif TC",
    "SourceHanSerifTC-Regular",
    "AR PL UMing TW",
  ],
  "tc-sans": [
    "PingFangTC-Regular",
    "PingFang TC Regular",
    "STHeitiTC-Light",
    "Heiti TC Light",
    "Microsoft JhengHei",
    "Noto Sans CJK TC",
    "NotoSansCJKtc-Regular",
    "Noto Sans TC",
    "Source Han Sans TC",
    "SourceHanSansTC-Regular",
    "WenQuanYi Zen Hei",
  ],
  "tc-kai": [
    "STKaitiTC-Regular",
    "Kaiti TC Regular",
    "BiauKaiTC-Regular",
    "BiauKaiTC Regular",
    "DFKai-SB",
    "AR PL UKai TW",
  ],
  "jp-serif": [
    "HiraMinProN-W3",
    "Hiragino Mincho ProN W3",
    "Yu Mincho",
    "YuMincho-Regular",
    "MS Mincho",
    "MS PMincho",
    "Noto Serif CJK JP",
    "NotoSerifCJKjp-Regular",
    "Noto Serif JP",
    "Source Han Serif",
    "SourceHanSerif-Regular",
    "IPAexMincho",
    "IPAMincho",
  ],
  "jp-sans": [
    "HiraginoSans-W3",
    "Hiragino Sans W3",
    "HiraKakuProN-W3",
    "Hiragino Kaku Gothic ProN W3",
    "Yu Gothic",
    "YuGothic-Medium",
    "Meiryo",
    "MS Gothic",
    "MS PGothic",
    "Noto Sans CJK JP",
    "NotoSansCJKjp-Regular",
    "Noto Sans JP",
    "Source Han Sans",
    "SourceHanSans-Regular",
    "IPAexGothic",
    "IPAGothic",
  ],
  "kr-serif": [
    "AppleMyungjo",
    "AppleMyungjo Regular",
    "Batang",
    "Noto Serif CJK KR",
    "NotoSerifCJKkr-Regular",
    "Noto Serif KR",
    "Source Han Serif K",
    "SourceHanSerifK-Regular",
    "UnBatang",
    "NanumMyeongjo",
  ],
  "kr-sans": [
    "AppleSDGothicNeo-Regular",
    "Apple SD Gothic Neo Regular",
    "Malgun Gothic",
    "Gulim",
    "Dotum",
    "Noto Sans CJK KR",
    "NotoSansCJKkr-Regular",
    "Noto Sans KR",
    "Source Han Sans K",
    "SourceHanSansK-Regular",
    "NanumGothic",
    "UnDotum",
  ],
} satisfies Partial<Record<`${CjkScript}-${CjkStyle}`, string[]>>;

export type FaceKey = keyof typeof LOCAL_FONTS;

export const familyOf = (key: FaceKey) => `zcode-cjk-${key}`;

// 规则按顺序匹配小写、去空格与下划线的字体名。仿/楷 先于 宋（FangSong 含 song）；
// HeiseiMin 的 hei 不算黑体。
const STYLE_RULES: [RegExp, CjkStyle][] = [
  [/fang|仿/, "fang"],
  [/kai|楷/, "kai"],
  [/hei(?!sei)|gothic|kakugo|kozgo|gulim|dotum|yuanti|ゴシック|黑|黒|굴림|돋움|고딕/, "sans"],
  [
    /song|sung|simsun|ming|mincho|kozmin|ryumin|heiseimin|batang|myeongjo|myungjo|宋|明|바탕|명조/,
    "serif",
  ],
];
/** Style words that alone do not make a font CJK (Noto Sans, Source Han Serif need a script word). */
const GENERIC_STYLE_RULES: [RegExp, CjkStyle][] = [
  [/sans/, "sans"],
  [/serif/, "serif"],
];
const SCRIPT_RULES: [RegExp, CjkScript][] = [
  [
    /^hy|batang|gulim|dotum|malgun|myeongjo|myungjo|nanum|^un(batang|dotum)|applesdgothic|cjkkr|(kr|ko)\b|바탕|굴림|돋움|명조|고딕/,
    "kr",
  ],
  [/^msung|^mhei|mingliu|dfkai|biaukai|jhenghei|lisong|cjktc|(tc|tw|hk)\b|細明|標楷/, "tc"],
  [
    /heisei|mincho|kozmin|kozgo|ryumin|gothicbbb|hira(kaku|min|maru)|hiraginosans(?!gb)|yu(gothic|mincho)|meiryo|ms-?p?gothic|ipa(ex)?(mincho|gothic)|cjkjp|jp\b|明朝|ゴシック/,
    "jp",
  ],
  [
    /simsun|simhei|stsong|stheiti|stkaiti|stfangsong|yahei|^fz|songti|heiti|kaiti|fangsong|gb2312|cjksc|(sc|cn|gb)\b|宋|黑|楷|仿/,
    "sc",
  ],
];

/** Decoders for font names stored as raw multi-byte strings, with the script each implies. */
const NAME_ENCODINGS: [string, CjkScript | null][] = [
  ["utf-8", null],
  ["gbk", "sc"],
  ["big5", "tc"],
  ["shift_jis", "jp"],
  ["euc-kr", "kr"],
];

/** Script and style words in a name; null when nothing in it is CJK-specific. */
function classifyText(name: string): { script: CjkScript | null; style: CjkStyle | null } | null {
  const key = name.replace(/[\s_]+/g, "").toLowerCase();
  const cjkStyle = STYLE_RULES.find(([rule]) => rule.test(key))?.[1] ?? null;
  const script = SCRIPT_RULES.find(([rule]) => rule.test(key))?.[1] ?? null;
  if (!cjkStyle && !script) return null;
  const style = cjkStyle ?? GENERIC_STYLE_RULES.find(([rule]) => rule.test(key))?.[1] ?? null;
  return { script, style };
}

/**
 * What a font name says about its script and style, or null for a non-CJK name. pdf.js keeps the
 * raw bytes of a name as Latin-1 characters; multi-byte names are decoded before matching.
 */
export function classifyFontName(name: string): CjkProfile | null {
  const raw = name.replace(/^[A-Z]{6}\+/, "");
  if (!/[\x80-\xff]/.test(raw) || /[\u0100-\uffff]/.test(raw)) {
    const found = classifyText(raw);
    return found && { script: found.script ?? "sc", style: found.style };
  }
  const bytes = Uint8Array.from(raw, (char) => char.charCodeAt(0));
  for (const [encoding, implied] of NAME_ENCODINGS) {
    let decoded: string;
    try {
      decoded = new TextDecoder(encoding, { fatal: true }).decode(bytes);
    } catch {
      continue;
    }
    // 只采信能认出字形或文种的解码：GBK 几乎总能解码成功，Big5 / Shift-JIS 名会被它误读。
    const found = classifyText(decoded);
    if (found) return { script: found.script ?? implied ?? "sc", style: found.style };
  }
  return null;
}

/**
 * The `zcode-cjk-*` families for a font pdf.js has no file for, best first; empty for embedded and
 * Type 3 fonts.
 */
export function cjkFamilies(font: PdfFontLike, fallbackReady: boolean): string[] {
  if (!font.missingFile || font.isType3Font) return [];
  const profile = classifyFontName(font.name ?? "");
  const script = profile?.script ?? "sc";
  const style = profile?.style ?? (font.fallbackName === "serif" ? "serif" : "sans");
  const own = `${script}-${style}`;
  const serif: FaceKey = `${script}-serif`;
  const keys: FaceKey[] = own in LOCAL_FONTS ? [own as FaceKey] : [];
  // 楷体、仿宋缺失时退到同文种的宋体，而不是黑体；日韩没有这两类，直接用宋体。
  if (style !== "sans" && !keys.includes(serif)) keys.push(serif);
  return [...keys.map(familyOf), ...(fallbackReady ? [FALLBACK_FAMILY] : [])];
}

const GENERIC_FAMILIES = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
]);

/** Insert `families` into a CSS font-family list, before its trailing generic family. */
export function withCjkFamilies(css: string, families: string[]): string {
  if (!families.length) return css;
  const parts = css.split(",");
  const quoted = families.map((family) => `"${family}"`);
  const last = parts.at(-1)!.trim();
  if (!GENERIC_FAMILIES.has(last)) return [...parts, ...quoted].join(",");
  return [...parts.slice(0, -1), ...quoted, last].join(",");
}
