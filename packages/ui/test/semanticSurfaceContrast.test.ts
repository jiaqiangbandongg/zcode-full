import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { SourceServerUpdateActivity } from "@/settings/SourceServerUpdateActivity.js";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * 合同 §8.3 / 审计 §9 门禁：36 组合对比度单测必须以 styles.css 的真实 token 链取值——
 * 主题块 → :root 级联 → Tailwind v4 调色板（oklch），token 改值测试必须变红。
 * 解析不了的构造一律抛错失败，禁止静默跳过或回退硬编码近似值。
 */

const stylesCss = stripComments(
  readFileSync(new URL("../src/styles.css", import.meta.url), "utf8"),
);
const tailwindThemeCss = stripComments(
  readFileSync(createRequire(import.meta.url).resolve("tailwindcss/theme.css"), "utf8"),
);

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** 提取选择器的首个规则块（花括号深度配对），找不到即抛错。 */
function extractBlock(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{`).exec(css);
  if (!match) throw new Error(`selector not found in styles.css: ${selector}`);
  const start = match.index + match[0].length;
  let depth = 1;
  for (let index = start; index < css.length; index += 1) {
    if (css[index] === "{") depth += 1;
    else if (css[index] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(start, index);
    }
  }
  throw new Error(`unclosed block for selector: ${selector}`);
}

function parseDeclarations(block: string): Map<string, string> {
  const declarations = new Map<string, string>();
  for (const statement of block.split(";")) {
    const match = /^\s*(--[\w-]+)\s*:\s*([\s\S]+)$/.exec(statement);
    if (match) declarations.set(match[1]!, match[2]!.trim());
  }
  return declarations;
}

interface Rgba {
  red: number;
  green: number;
  blue: number;
  alpha: number;
}

type Scope = ReadonlyArray<Map<string, string>>;

function resolveToken(name: string, scopes: Scope): Rgba {
  for (const scope of scopes) {
    const value = scope.get(name);
    if (value !== undefined) return parseColorValue(value, scopes);
  }
  throw new Error(`token not defined in any scope: ${name}`);
}

function parseColorValue(rawValue: string, scopes: Scope): Rgba {
  const value = rawValue.replace(/\s+/g, " ").trim();
  if (value === "transparent") return { red: 0, green: 0, blue: 0, alpha: 0 };
  const varMatch = /^var\((--[\w-]+)\)$/.exec(value);
  if (varMatch) return resolveToken(varMatch[1]!, scopes);
  if (value.startsWith("#")) return parseHexColor(value);
  const rgbaMatch = /^rgba?\(([^)]+)\)$/.exec(value);
  if (rgbaMatch) {
    const parts = rgbaMatch[1]!.split(",").map((part) => Number(part.trim()));
    if (parts.length < 3 || parts.some(Number.isNaN)) {
      throw new Error(`unsupported rgba() value: ${value}`);
    }
    return {
      red: parts[0]!,
      green: parts[1]!,
      blue: parts[2]!,
      alpha: parts[3] ?? 1,
    };
  }
  const oklchMatch = /^oklch\(([^)]+)\)$/.exec(value);
  if (oklchMatch) return parseOklch(oklchMatch[1]!);
  const mixMatch =
    /^color-mix\(\s*in\s+(srgb|oklab)\s*,\s*([\s\S]+?)\s+([\d.]+)%\s*,\s*transparent\s*\)$/.exec(
      value,
    );
  if (mixMatch) {
    // 与 transparent 的 premultiplied 混合只缩放 alpha、不改变色度分量，
    // srgb 与 oklab 插值空间在该形态下结果一致；两色混合形态当前 token 不存在，直接拒绝。
    const base = parseColorValue(mixMatch[2]!, scopes);
    return { ...base, alpha: base.alpha * (Number(mixMatch[3]) / 100) };
  }
  throw new Error(`unsupported color value: ${value}`);
}

function parseHexColor(value: string): Rgba {
  const hex = value.slice(1);
  if (hex.length === 3) {
    return {
      red: Number.parseInt(hex[0]! + hex[0]!, 16),
      green: Number.parseInt(hex[1]! + hex[1]!, 16),
      blue: Number.parseInt(hex[2]! + hex[2]!, 16),
      alpha: 1,
    };
  }
  if (hex.length === 6) {
    return {
      red: Number.parseInt(hex.slice(0, 2), 16),
      green: Number.parseInt(hex.slice(2, 4), 16),
      blue: Number.parseInt(hex.slice(4, 6), 16),
      alpha: 1,
    };
  }
  throw new Error(`unsupported hex color: ${value}`);
}

function parseOklch(body: string): Rgba {
  const [components, alphaPart] = body.split("/").map((part) => part.trim());
  const parts = components!.split(/\s+/);
  if (parts.length !== 3) throw new Error(`unsupported oklch() value: ${body}`);
  const lightness = parts[0]!.endsWith("%")
    ? Number(parts[0]!.slice(0, -1)) / 100
    : Number(parts[0]);
  const chroma = Number(parts[1]);
  const hue = parts[2] === "none" ? 0 : Number(parts[2]);
  const alpha = alphaPart
    ? alphaPart.endsWith("%")
      ? Number(alphaPart.slice(0, -1)) / 100
      : Number(alphaPart)
    : 1;
  if ([lightness, chroma, hue, alpha].some(Number.isNaN)) {
    throw new Error(`unsupported oklch() value: ${body}`);
  }
  return { ...oklchToSrgb(lightness, chroma, hue), alpha };
}

/** OKLCH → OKLab → LMS → linear sRGB → gamma sRGB（Björn Ottosson 参考实现系数）。 */
function oklchToSrgb(
  lightness: number,
  chroma: number,
  hueDegrees: number,
): Pick<Rgba, "red" | "green" | "blue"> {
  const hue = (hueDegrees * Math.PI) / 180;
  const labA = chroma * Math.cos(hue);
  const labB = chroma * Math.sin(hue);
  const l = (lightness + 0.3963377774 * labA + 0.2158037573 * labB) ** 3;
  const m = (lightness - 0.1055613458 * labA - 0.0638541728 * labB) ** 3;
  const s = (lightness - 0.0894841775 * labA - 1.291485548 * labB) ** 3;
  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((channel) => {
    const clamped = Math.min(1, Math.max(0, channel));
    return clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * clamped ** (1 / 2.4) - 0.055;
  });
  return {
    red: linear[0]! * 255,
    green: linear[1]! * 255,
    blue: linear[2]! * 255,
  };
}

/** 半透明前景按 alpha 叠到不透明底色上（sRGB 分量插值，即浏览器合成行为）。 */
function flattenOver(top: Rgba, bottom: Rgba): Rgba {
  if (bottom.alpha !== 1) {
    throw new Error("flatten target must be opaque");
  }
  return {
    red: top.red * top.alpha + bottom.red * (1 - top.alpha),
    green: top.green * top.alpha + bottom.green * (1 - top.alpha),
    blue: top.blue * top.alpha + bottom.blue * (1 - top.alpha),
    alpha: 1,
  };
}

function wcagLuminance(color: Rgba): number {
  const channels = [color.red, color.green, color.blue].map((value) => {
    const normalized = value / 255;
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
}

function contrastRatio(foreground: Rgba, background: Rgba): number {
  const light = Math.max(wcagLuminance(foreground), wcagLuminance(background));
  const dark = Math.min(wcagLuminance(foreground), wcagLuminance(background));
  return (light + 0.05) / (dark + 0.05);
}

const paletteScope = parseDeclarations(tailwindThemeCss);
// 默认亮主题的语义 token 定义在 Tailwind v4 的 @theme 块，其余主题以类选择器覆盖级联。
const baseThemeScope = parseDeclarations(extractBlock(stylesCss, "@theme"));
const rootScope = parseDeclarations(extractBlock(stylesCss, ":root"));
const themeSelectors = {
  defaultLight: "@theme",
  defaultDark: ".dark",
  zaiLight: ".theme-zai-light",
  zaiDark: ".theme-zai-dark",
} as const;
const parentBackgrounds = [
  "background",
  "surface",
  "card",
  "sidebar",
  "popover",
  "selected",
] as const;
const semantics = ["warning", "destructive", "success", "progress"] as const;

describe("remote UI semantic surface tokens", () => {
  it("keeps all 96 theme/background/semantic combinations readable with real token values", () => {
    const combinations: string[] = [];
    const violations: string[] = [];
    for (const [theme, selector] of Object.entries(themeSelectors)) {
      const themeScope = parseDeclarations(extractBlock(stylesCss, selector));
      const scopes: Scope = [themeScope, baseThemeScope, paletteScope];
      const pageBackground = resolveToken("--color-background", scopes);
      if (pageBackground.alpha !== 1) {
        throw new Error(`--color-background must be opaque in ${theme}`);
      }
      for (const parent of parentBackgrounds) {
        const parentColor = resolveToken(`--color-${parent}`, scopes);
        const resolvedParent =
          parent === "background" ? pageBackground : flattenOver(parentColor, pageBackground);
        for (const semantic of semantics) {
          const surface = resolveToken(`--color-${semantic}-surface`, scopes);
          const foreground = resolveToken(`--color-${semantic}-surface-foreground`, scopes);
          if (foreground.alpha !== 1) {
            throw new Error(`surface foreground must be opaque: ${theme}/${semantic}`);
          }
          const composedSurface = flattenOver(surface, resolvedParent);
          const ratio = contrastRatio(foreground, composedSurface);
          combinations.push(`${theme}/${parent}/${semantic}`);
          if (ratio < 4.5) {
            violations.push(`${theme}/${parent}/${semantic} contrast=${ratio.toFixed(2)}`);
          }
        }
      }
    }
    expect(combinations).toHaveLength(96);
    // 阈值 4.5:1 是 §8.3 合同的硬门禁；失败即 token 取值的规格缺陷，修 token 并回写文档。
    expect(violations).toEqual([]);
  });

  it("远程标签、侧栏和设置导航在四个主题中达到 4.5:1", () => {
    const violations: string[] = [];
    for (const [theme, selector] of Object.entries(themeSelectors)) {
      const scopes: Scope = [
        parseDeclarations(extractBlock(stylesCss, selector)),
        rootScope,
        baseThemeScope,
        paletteScope,
      ];
      const page = resolveToken("--color-background", scopes);
      for (const parent of ["sidebar", "popover", "surface", "card", "selected", "background"]) {
        const background = flattenOver(resolveToken(`--color-${parent}`, scopes), page);
        for (const text of ["foreground", "remote-foreground-muted"]) {
          const foreground = flattenOver(resolveToken(`--color-${text}`, scopes), background);
          const ratio = contrastRatio(foreground, background);
          if (ratio < 4.5) violations.push(`${theme}/${parent}/${text}: ${ratio.toFixed(2)}`);
        }
        for (const kind of ["ssh", "wsl", "docker"]) {
          const surface = flattenOver(
            resolveToken(`--color-remote-${kind}-surface`, scopes),
            background,
          );
          const foreground = flattenOver(
            resolveToken(`--color-remote-${kind}-foreground`, scopes),
            surface,
          );
          const ratio = contrastRatio(foreground, surface);
          if (ratio < 4.5) violations.push(`${theme}/${parent}/${kind}: ${ratio.toFixed(2)}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("registers every remote descriptor token triplet in all four themes", () => {
    const descriptors = ["remote-ssh", "remote-wsl", "remote-docker"] as const;
    const channels = ["surface", "foreground", "border"] as const;

    for (const [theme, selector] of Object.entries(themeSelectors)) {
      const themeScope = parseDeclarations(extractBlock(stylesCss, selector));
      const scopes: Scope = [themeScope, rootScope, baseThemeScope, paletteScope];
      for (const descriptor of descriptors) {
        for (const channel of channels) {
          expect(
            () => resolveToken(`--color-${descriptor}-${channel}`, scopes),
            `${theme} ${descriptor}-${channel}`,
          ).not.toThrow();
        }
      }
    }
  });

  it("keeps the dedicated continuity panel readable in all four themes", () => {
    for (const [theme, selector] of Object.entries(themeSelectors)) {
      const themeScope = parseDeclarations(extractBlock(stylesCss, selector));
      const scopes: Scope = [themeScope, rootScope, baseThemeScope, paletteScope];
      const panel = resolveToken("--color-remote-continuity-panel", scopes);
      const surface = resolveToken("--color-remote-continuity-panel-surface", scopes);
      const foreground = resolveToken("--color-remote-continuity-panel-foreground", scopes);
      const subtle = resolveToken("--color-remote-continuity-panel-subtle", scopes);

      expect(contrastRatio(foreground, panel), `${theme} foreground`).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(subtle, panel), `${theme} subtle`).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(foreground, surface), `${theme} surface`).toBeGreaterThanOrEqual(4.5);
    }
  });
});

it("真实设备日志时间戳在四主题背景上达到 4.5:1", () => {
  const html = renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "en-US" },
      createElement(SourceServerUpdateActivity, {
        active: true,
        logs: [
          {
            profileId: "17ef20b3-622d-4a53-98c1-0cdff29f3e6d",
            operation: "connect",
            phase: "ready",
            level: "info",
            message: "ready",
            timestamp: 1,
          },
        ],
      }),
    ),
  );
  const classes = /data-source-server-log-timestamp="true" class="([^"]+)"/u.exec(html)?.[1];
  const token = classes
    ?.split(" ")
    .find((name) => name.startsWith("text-"))
    ?.slice(5);
  expect(token).toBeTruthy();
  for (const [theme, selector] of Object.entries(themeSelectors)) {
    const scopes: Scope = [
      parseDeclarations(extractBlock(stylesCss, selector)),
      rootScope,
      baseThemeScope,
      paletteScope,
    ];
    const background = resolveToken("--color-background", scopes);
    const text = flattenOver(resolveToken(`--color-${token}`, scopes), background);
    expect(contrastRatio(text, background), theme).toBeGreaterThanOrEqual(4.5);
  }
});
