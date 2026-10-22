import type { DocKind } from "#office/kinds.ts";

/**
 * Which plugin this build is. Each plugin package declares its title and formats under
 * `office` in its package.json; scripts/build.mjs replaces this module with those values.
 * The default here opens every format; tests and the type checker use it. No plugin ships it.
 */
export interface Profile {
  /** Plugin, MCP server and panel surface name, e.g. `documents` or `pdf`. */
  name: string;
  version: string;
  title: { en: string; "zh-CN": string };
  /** Formats this plugin opens, in display order. */
  kinds: readonly DocKind[];
}

export const PROFILE: Profile = {
  name: "office",
  version: "0.0.0",
  title: { en: "Office", "zh-CN": "Office 文档" },
  kinds: ["docx", "xlsx", "pptx", "pdf"],
};
