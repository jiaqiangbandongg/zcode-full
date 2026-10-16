import type { FileDiffOptions } from "@pierre/diffs";
import type { BundledTheme } from "shiki";

import { DIFFS_PREFERRED_HIGHLIGHTER } from "@/lib/diffsHighlighterEngine.js";
import type { ResolvedTheme } from "@/useTheme.js";

interface PatchDiffSettings {
  lightTheme: BundledTheme;
  darkTheme: BundledTheme;
  showLineNumbers: boolean;
  wrapLongLines: boolean;
}

type PatchDiffSeparatorStyle = "line-info" | "simple";

const PATCH_DIFF_UNSAFE_CSS = `
/* 修复原因：PatchDiff 渲染在 Shadow DOM 内，外层的 Tailwind 选择器无法命中内部 code 节点。
 * 这里必须通过 unsafeCSS 注入到 shadow root，才能真正覆盖库自己的 code padding 和背景色。
 * 另外库在横向滚动时会把左侧 gutter 做成 sticky；如果把底色设成 transparent，
 * 正文就会从行号列下面“穿过去”，导致拖动滑块时行号和文字视觉重叠。 */
:host {
  --diffs-light-bg: var(--color-background, #fff);
  --diffs-dark-bg: var(--color-background, #000);
}

[data-code],
[data-separator-content],
pre {
  padding: 0 !important;
  background: transparent !important;
}

[data-code] span,
[data-separator-content] span {
  background: transparent !important;
}

[data-code] {
  background-color: transparent !important;
}

[data-separator-wrapper] {
  padding-left: 64px !important;
}

[data-separator-wrapper] {
  background: var(--color-surface) !important;
}

[data-separator-content] {
  background-color: transparent !important;
}
[data-column-number] {
  border-right-color: rgba(0, 0, 0, 0.1) !important;
}
`;

export function createPatchDiffOptions(
  codePreviewSettings: PatchDiffSettings,
  resolvedTheme: ResolvedTheme,
  options?: {
    separatorStyle?: PatchDiffSeparatorStyle;
  },
): FileDiffOptions<undefined> {
  return {
    diffStyle: "unified",
    diffIndicators: "classic",
    disableFileHeader: true,
    disableLineNumbers: !codePreviewSettings.showLineNumbers,
    // Bugfix: “上一轮更改”这类紧凑 diff 更关注快速定位修改点，
    // 不需要额外展示“123 unmodified lines”标签。这里允许调用方切到 simple，
    // 把大段未改动区域退化成轻量空白分隔，避免视觉上抢走改动本身的注意力。
    hunkSeparators: options?.separatorStyle ?? "line-info",
    overflow: codePreviewSettings.wrapLongLines ? "wrap" : "scroll",
    theme: {
      light: codePreviewSettings.lightTheme,
      dark: codePreviewSettings.darkTheme,
    },
    themeType: resolvedTheme,
    preferredHighlighter: DIFFS_PREFERRED_HIGHLIGHTER,
    unsafeCSS: PATCH_DIFF_UNSAFE_CSS,
  };
}
