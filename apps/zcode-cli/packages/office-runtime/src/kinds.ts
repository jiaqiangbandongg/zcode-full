/**
 * Every format the runtime knows; a plugin opens the subset in its profile.
 * 单独成文件：profile.ts 与 contract.ts 都要用到格式列表，放在 contract.ts 会形成循环依赖。
 */
export const ALL_KINDS = ["docx", "xlsx", "pptx", "pdf"] as const;
export type DocKind = (typeof ALL_KINDS)[number];
