import { SyntaxStyle, type ThemeTokenStyle } from "@mbears/opentui-core";
import type { TuiThemeTokens } from "./theme/index.js";

export function markdownSyntaxRules(theme: TuiThemeTokens): ThemeTokenStyle[] {
  return [
    token(["default"], { foreground: theme.markdownText }),
    token(["markup.heading", "markup.heading.1", "markup.heading.2", "markup.heading.3"], {
      bold: true,
      foreground: theme.markdownHeading,
    }),
    token(["markup.heading.4", "markup.heading.5", "markup.heading.6"], {
      bold: true,
      foreground: theme.markdownHeading,
    }),
    token(["markup.bold", "markup.strong"], {
      bold: true,
      foreground: theme.markdownStrong,
    }),
    token(["markup.italic"], { foreground: theme.markdownEmph, italic: true }),
    token(["markup.list"], { foreground: theme.markdownListItem }),
    token(["markup.quote"], { foreground: theme.markdownBlockQuote, italic: true }),
    token(["markup.raw", "markup.raw.block"], { foreground: theme.markdownCodeBlock }),
    token(["markup.raw.inline"], {
      background: theme.backgroundPanel,
      foreground: theme.markdownCode,
    }),
    token(["markup.link", "markup.link.url"], {
      foreground: theme.markdownLink,
      underline: true,
    }),
    token(["markup.link.label", "label"], {
      foreground: theme.markdownLinkText,
      underline: true,
    }),
    token(["conceal"], { foreground: theme.textMuted }),
    token(["comment"], { foreground: theme.syntaxComment, italic: true }),
    token(["string", "symbol"], { foreground: theme.syntaxString }),
    token(["number", "boolean"], { foreground: theme.syntaxNumber }),
    token(["keyword"], { foreground: theme.syntaxKeyword }),
    token(["function", "function.call", "function.method.call"], {
      foreground: theme.syntaxFunction,
    }),
    token(["type", "type.builtin"], { foreground: theme.syntaxType }),
    token(["operator"], { foreground: theme.syntaxOperator }),
    token(["punctuation", "punctuation.bracket"], { foreground: theme.syntaxPunctuation }),
    token(["diff.plus"], { foreground: theme.diffAdded }),
    token(["diff.minus"], { foreground: theme.diffRemoved }),
    token(["diff.delta"], { foreground: theme.diffHunkHeader }),
    token(["error"], { foreground: theme.error }),
    token(["warning"], { foreground: theme.warning }),
    token(["info"], { foreground: theme.info }),
  ];
}

export function createMarkdownSyntaxStyle(theme: TuiThemeTokens): SyntaxStyle | undefined {
  try {
    return SyntaxStyle.fromTheme(markdownSyntaxRules(theme));
  } catch {
    return undefined;
  }
}

function token(
  scope: string[],
  style: ThemeTokenStyle["style"],
): ThemeTokenStyle {
  return { scope, style };
}
