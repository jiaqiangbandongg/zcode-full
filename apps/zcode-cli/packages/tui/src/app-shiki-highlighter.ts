import path from "node:path";
import { bundledLanguages, createHighlighter, type BundledLanguage, type BundledTheme } from "shiki";
import type { TuiThemeMode } from "./theme/index.js";

const SHIKI_DARK_THEME = "github-dark";
const SHIKI_LIGHT_THEME = "github-light";
const SHIKI_THEMES = [SHIKI_DARK_THEME, SHIKI_LIGHT_THEME] as const;
const HIGHLIGHT_TIMEOUT_MS = 2_500;

const LANGUAGE_BY_FILENAME: Record<string, BundledLanguage> = {
  dockerfile: "dockerfile",
  makefile: "makefile",
};

const LANGUAGE_BY_EXTENSION: Record<string, BundledLanguage> = {
  cjs: "javascript",
  cts: "typescript",
  h: "c",
  hpp: "cpp",
  htm: "html",
  mjs: "javascript",
  mts: "typescript",
  psm1: "powershell",
  tsx: "tsx",
  jsx: "jsx",
  swift: "swift",
};

export type ShikiHighlightSegment = {
  color?: string;
  fontStyle?: number;
  text: string;
};

type ShikiHighlighter = Awaited<ReturnType<typeof createHighlighter>>;

let highlighterPromise: Promise<ShikiHighlighter> | undefined;
const loadedLanguages = new Set<BundledLanguage>();
const highlightCache = new Map<string, ShikiHighlightSegment[][] | undefined>();

export function inferShikiLanguage(filePath: string | undefined): BundledLanguage | undefined {
  if (!filePath) return undefined;
  const basename = path.basename(filePath).toLowerCase();
  const filenameMatch = LANGUAGE_BY_FILENAME[basename];
  if (filenameMatch) return filenameMatch;

  const extension = path.extname(basename).replace(/^\./u, "");
  if (!extension) return undefined;
  const mapped = LANGUAGE_BY_EXTENSION[extension] ?? extension;
  return isBundledLanguage(mapped) ? mapped : undefined;
}

export async function highlightShikiCodeLines(input: {
  filePath: string | undefined;
  lines: string[];
  mode: TuiThemeMode;
}): Promise<ShikiHighlightSegment[][] | undefined> {
  const language = inferShikiLanguage(input.filePath);
  if (!language) return undefined;

  const theme = shikiThemeForMode(input.mode);
  const cacheKey = `${theme}\0${language}\0${input.lines.join("\n")}`;
  if (highlightCache.has(cacheKey)) return highlightCache.get(cacheKey);

  const highlighted = await withTimeout(
    tokenizeLines({
      language,
      lines: input.lines,
      theme,
    }),
    HIGHLIGHT_TIMEOUT_MS,
  );
  highlightCache.set(cacheKey, highlighted);
  return highlighted;
}

export function resetShikiHighlighterForTest(): void {
  highlighterPromise = undefined;
  loadedLanguages.clear();
  highlightCache.clear();
}

async function tokenizeLines(input: {
  language: BundledLanguage;
  lines: string[];
  theme: BundledTheme;
}): Promise<ShikiHighlightSegment[][] | undefined> {
  try {
    const highlighter = await getHighlighter();
    if (!loadedLanguages.has(input.language)) {
      await highlighter.loadLanguage(input.language);
      loadedLanguages.add(input.language);
    }

    const result = highlighter.codeToTokens(input.lines.join("\n"), {
      lang: input.language,
      theme: input.theme,
    });
    return padTokenLines(
      result.tokens.map((line) =>
        line.map((token) => ({
          color: token.color,
          fontStyle: token.fontStyle,
          text: token.content,
        })),
      ),
      input.lines.length,
    );
  } catch {
    return undefined;
  }
}

function getHighlighter(): Promise<ShikiHighlighter> {
  highlighterPromise ??= createHighlighter({
    langs: [],
    themes: [...SHIKI_THEMES],
  });
  return highlighterPromise;
}

function isBundledLanguage(language: string): language is BundledLanguage {
  return Object.prototype.hasOwnProperty.call(bundledLanguages, language);
}

function shikiThemeForMode(mode: TuiThemeMode): BundledTheme {
  return mode === "light" ? SHIKI_LIGHT_THEME : SHIKI_DARK_THEME;
}

function padTokenLines(
  lines: ShikiHighlightSegment[][],
  expectedLength: number,
): ShikiHighlightSegment[][] {
  if (lines.length >= expectedLength) return lines.slice(0, expectedLength);
  return [...lines, ...Array.from({ length: expectedLength - lines.length }, () => [])];
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timeout = setTimeout(() => resolve(undefined), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
