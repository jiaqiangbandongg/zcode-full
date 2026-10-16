import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_WORKSPACE } from "../../../helpers/desktop-app.js";

const FIXTURE_DIR_RELATIVE = ".zcode-e2e/continue-markdown-otc10";
const FIXTURE_DIR = join(DEFAULT_WORKSPACE, FIXTURE_DIR_RELATIVE);
const LINK_TARGET_RELATIVE = `${FIXTURE_DIR_RELATIVE}/link-target.md`;
const IMAGE_ONE_RELATIVE = `${FIXTURE_DIR_RELATIVE}/one.svg`;
const IMAGE_TWO_RELATIVE = `${FIXTURE_DIR_RELATIVE}/two.svg`;

export const AUTOLINK = "https://example.com/autolink";
export const CITATION_TARGET_PATH = join(FIXTURE_DIR, "citation.txt");
export const COMPACT_REQUEST_QUERY = {
  includes: ["CRITICAL: Respond with TEXT ONLY"],
};
export const EXTERNAL_LINK = "https://example.com/otc10";
export const LINK_TARGET_PATH = join(DEFAULT_WORKSPACE, LINK_TARGET_RELATIVE);
export const REFERENCE_LINK = "https://example.com/reference";

export type MarkdownContinueCaseId =
  | "paragraph"
  | "newline-after-partial"
  | "soft-break-at-continue-start"
  | "hard-break"
  | "heading"
  | "blockquote"
  | "unordered-list"
  | "ordered-list"
  | "task-list"
  | "nested-list"
  | "thematic-break"
  | "fenced-code"
  | "table"
  | "emphasis"
  | "strong"
  | "strikethrough"
  | "inline-code"
  | "external-link"
  | "workspace-file-link"
  | "reference-link"
  | "autolink"
  | "single-image"
  | "image-gallery"
  | "inline-math"
  | "display-math"
  | "mermaid"
  | "zcode-file-citation";

export interface MarkdownContinueCaseDefinition {
  finalAnchor: string;
  id: MarkdownContinueCaseId;
  partial: string;
  continuation: string;
}

export const MARKDOWN_CONTINUE_CASES: readonly MarkdownContinueCaseDefinition[] = [
  {
    id: "paragraph",
    partial: "段落在 Continue 中途截",
    continuation: "断后自然拼接完成。 PARAGRAPH_DONE",
    finalAnchor: "PARAGRAPH_DONE",
  },
  {
    id: "newline-after-partial",
    partial: "第一行在 partial 末尾。\n",
    continuation: "第二行从 continuation 开始。 NEWLINE_AFTER_PARTIAL_DONE",
    finalAnchor: "NEWLINE_AFTER_PARTIAL_DONE",
  },
  {
    id: "soft-break-at-continue-start",
    partial: "软换行第一行",
    continuation: "\n软换行第二行。 SOFT_BREAK_DONE",
    finalAnchor: "SOFT_BREAK_DONE",
  },
  {
    id: "hard-break",
    partial: "硬换行第一行  ",
    continuation: "\n硬换行第二行。 HARD_BREAK_DONE",
    finalAnchor: "HARD_BREAK_DONE",
  },
  {
    id: "heading",
    partial: "## Continue 标",
    continuation: "题完整 HEADING_DONE",
    finalAnchor: "HEADING_DONE",
  },
  {
    id: "blockquote",
    partial: "> 引用内容跨",
    continuation: "越断点。 BLOCKQUOTE_DONE",
    finalAnchor: "BLOCKQUOTE_DONE",
  },
  {
    id: "unordered-list",
    partial: "- bullet 项跨",
    continuation: "越断点。 UNORDERED_LIST_DONE",
    finalAnchor: "UNORDERED_LIST_DONE",
  },
  {
    id: "ordered-list",
    partial: "1. ordered 项跨",
    continuation: "越断点。 ORDERED_LIST_DONE",
    finalAnchor: "ORDERED_LIST_DONE",
  },
  {
    id: "task-list",
    partial: "- [x] task 项跨",
    continuation: "越断点。 TASK_LIST_DONE",
    finalAnchor: "TASK_LIST_DONE",
  },
  {
    id: "nested-list",
    partial: "- 父项\n  - 子项跨",
    continuation: "越断点。 NESTED_LIST_DONE",
    finalAnchor: "NESTED_LIST_DONE",
  },
  {
    id: "thematic-break",
    partial: "分隔线之前。\n\n--",
    continuation: "-\n\nTHEMATIC_BREAK_DONE",
    finalAnchor: "THEMATIC_BREAK_DONE",
  },
  {
    id: "fenced-code",
    partial: '```ts\nconst partial = "P1";\n',
    continuation: 'const continuation = "P2";\n```\n\nFENCED_CODE_DONE',
    finalAnchor: "FENCED_CODE_DONE",
  },
  {
    id: "table",
    partial: "| 列 A | 列 B |\n| --- | --- |\n| partial |",
    continuation: " continuation |\n\nTABLE_DONE",
    finalAnchor: "TABLE_DONE",
  },
  {
    id: "emphasis",
    partial: "*斜体跨",
    continuation: "越断点* EMPHASIS_DONE",
    finalAnchor: "EMPHASIS_DONE",
  },
  {
    id: "strong",
    partial: "**粗体跨",
    continuation: "越断点** STRONG_DONE",
    finalAnchor: "STRONG_DONE",
  },
  {
    id: "strikethrough",
    partial: "~~删除线跨",
    continuation: "越断点~~ STRIKETHROUGH_DONE",
    finalAnchor: "STRIKETHROUGH_DONE",
  },
  {
    id: "inline-code",
    partial: "`inline-",
    continuation: "continue` INLINE_CODE_DONE",
    finalAnchor: "INLINE_CODE_DONE",
  },
  {
    id: "external-link",
    partial: "[外部链接跨",
    continuation: `越断点](${EXTERNAL_LINK}) EXTERNAL_LINK_DONE`,
    finalAnchor: "EXTERNAL_LINK_DONE",
  },
  {
    id: "workspace-file-link",
    partial: "[工作区文件跨",
    continuation: `越断点](${LINK_TARGET_RELATIVE}) WORKSPACE_FILE_LINK_DONE`,
    finalAnchor: "WORKSPACE_FILE_LINK_DONE",
  },
  {
    id: "reference-link",
    partial: "[引用式链接][ref]\n\n[ref]: https://example.com/ref",
    continuation: "erence\n\nREFERENCE_LINK_DONE",
    finalAnchor: "REFERENCE_LINK_DONE",
  },
  {
    id: "autolink",
    partial: "<https://example.com/auto",
    continuation: "link> AUTOLINK_DONE",
    finalAnchor: "AUTOLINK_DONE",
  },
  {
    id: "single-image",
    partial: "![单图跨",
    continuation: `越断点](${IMAGE_ONE_RELATIVE})\n\nSINGLE_IMAGE_DONE`,
    finalAnchor: "SINGLE_IMAGE_DONE",
  },
  {
    id: "image-gallery",
    partial: `![画廊一](${IMAGE_ONE_RELATIVE})\n\n![画廊`,
    continuation: `二](${IMAGE_TWO_RELATIVE})\n\nIMAGE_GALLERY_DONE`,
    finalAnchor: "IMAGE_GALLERY_DONE",
  },
  {
    id: "inline-math",
    partial: "行内公式 $E = m",
    continuation: "c^2$ INLINE_MATH_DONE",
    finalAnchor: "INLINE_MATH_DONE",
  },
  {
    id: "display-math",
    partial: "$$\na^2 + b",
    continuation: "^2 = c^2\n$$\n\nDISPLAY_MATH_DONE",
    finalAnchor: "DISPLAY_MATH_DONE",
  },
  {
    id: "mermaid",
    partial: "```mermaid\ngraph TD\n  A[partial] -->",
    continuation: " B[continue]\n```\n\nMERMAID_DONE",
    finalAnchor: "MERMAID_DONE",
  },
  {
    id: "zcode-file-citation",
    partial: `::zcode-file-citation{path="${FIXTURE_DIR_RELATIVE}/cita`,
    continuation: 'tion.txt" purpose="output"}\n\nZCODE_FILE_CITATION_DONE',
    finalAnchor: "ZCODE_FILE_CITATION_DONE",
  },
];

export function buildSubcaseMarker(id: MarkdownContinueCaseId) {
  return `OTC10_${id.replaceAll("-", "_").toUpperCase()}`;
}

export function buildFixtureId(id: MarkdownContinueCaseId, phase: "partial" | "final") {
  return `otc10-${id}-${phase}`;
}

export async function writeMarkdownFixtures() {
  await mkdir(FIXTURE_DIR, { recursive: true });
  await Promise.all([
    writeFile(
      join(FIXTURE_DIR, "one.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#2563eb"/><text x="24" y="100" fill="white" font-size="24">OTC10 one</text></svg>',
      "utf8",
    ),
    writeFile(
      join(FIXTURE_DIR, "two.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#16a34a"/><text x="24" y="100" fill="white" font-size="24">OTC10 two</text></svg>',
      "utf8",
    ),
    writeFile(join(FIXTURE_DIR, "link-target.md"), "# OTC10 workspace link\n", "utf8"),
    writeFile(join(FIXTURE_DIR, "citation.txt"), "OTC10 citation target\n", "utf8"),
  ]);
}

export async function removeMarkdownFixtures() {
  await rm(FIXTURE_DIR, { force: true, recursive: true });
}
