import { MAX_FILE_BYTES, DOC_KINDS, extensionList, joinList } from "#office/contract.ts";
import { PROFILE } from "#office/profile.ts";

const FORMAT_NAMES = { docx: "Word", xlsx: "Excel", pptx: "PowerPoint", pdf: "PDF" } as const;
const formats = DOC_KINDS.map((kind) => FORMAT_NAMES[kind]);
const has = (kind: (typeof DOC_KINDS)[number]) => DOC_KINDS.includes(kind);
const passage = has("docx") || has("pdf");
/** What the user can select, e.g. "any passage, cell or slide". */
const selectable = {
  en: `any ${joinList(
    [
      ...(passage ? ["passage"] : []),
      ...(has("xlsx") ? ["cell"] : []),
      ...(has("pptx") ? ["slide"] : []),
    ],
    "en",
    "or",
  )}`,
  zh: joinList(
    [
      ...(passage ? ["段落"] : []),
      ...(has("xlsx") ? ["单元格"] : []),
      ...(has("pptx") ? ["幻灯片"] : []),
    ],
    "zh-CN",
    "or",
  ),
};
/** The panel title as the start of a Chinese sentence: "Office 文档", or "PDF " before Chinese text. */
const zhTitle = PROFILE.title["zh-CN"].replace(/[\x20-\x7e]$/, "$& ");

const en = {
  title: PROFILE.title.en,
  openTitle: "Open a document",
  openFile: "Open file",
  emptyTitle: `Open your ${joinList(formats)} file`,
  emptyDescription: `Read alongside your conversation and discuss ${selectable.en}.`,
  emptyCaption: `Choose a local file · ${extensionList("en", "or")}`,
  importing: "Importing…",
  importTooLarge: `Choose a file no larger than ${MAX_FILE_BYTES / 1024 / 1024} MiB.`,

  recent: "Recent",
  switchDocument: "Switch document",
  pagesAndOutline: "Pages and outline",
  outlineOnly: "Outline",
  pages: "Pages",
  slides: "Slides",
  outline: "Outline",
  find: "Find",
  findPlaceholder: "Find in document",
  findCount: (index: number, total: number) => `${index} of ${total}`,
  noResults: "No results",
  previousMatch: "Previous match (⇧Enter)",
  nextMatch: "Next match (Enter)",
  closeFind: "Close (Esc)",
  more: "More",
  fitWidth: "Fit width",
  fitPage: "Fit page",
  actualSize: "Actual size",
  reload: "Reload from disk",
  previousPage: "Previous page",
  nextPage: "Next page",
  pageNumber: "Page number",
  ofPages: (count: number) => `of ${count}`,
  zoomIn: "Zoom in (⌘+)",
  zoomOut: "Zoom out (⌘−)",
  fit: "Fit",
  addToChat: "Add to chat",
  addShort: "Add",
  addToChatHint: "Attach this to your next message (⌘/Ctrl+Enter)",
  added: "Added to chat",
  ask: "Ask",
  askPlaceholder: "Ask about this…",
  send: "Send",
  cancel: "Cancel",
  sendKey: "send",
  cancelKey: "cancel",
  copy: "Copy",
  copied: "Copied",
  agent: "Agent",
  agentOf: (index: number, total: number) => `Agent · ${index} of ${total}`,
  nextTarget: "Next",
  moreOn: (count: number, label: string) => (count === 1 ? `1 more on ${label}` : `${count} more`),
  close: "Close",
  changed: "This file changed on disk.",
  reloadShort: "Reload",
  dismiss: "Dismiss",
  openAnother: "Open another file",
  sidePanel: "Open in side panel",
  meta: {
    pdf: (n: number) => (n === 1 ? "1 page" : `${n} pages`),
    pptx: (n: number) => (n === 1 ? "1 slide" : `${n} slides`),
    xlsx: (n: number) => (n === 1 ? "1 sheet" : `${n} sheets`),
    docx: (_n: number) => "",
  },
  errors: {
    generic: ["Couldn’t open this document", ""],
    password: [
      "This PDF is password protected",
      `${PROFILE.title.en} can’t open encrypted files yet.`,
    ],
    not_found: ["This file no longer exists", "It may have been moved or deleted."],
    file_too_large: ["This file is too large to open", ""],
    corrupt_file: [
      "This file appears to be damaged",
      `${PROFILE.title.en} couldn’t read its contents.`,
    ],
    unsupported_type: [
      "This kind of file isn’t supported",
      `${PROFILE.title.en} opens ${extensionList()} files.`,
    ],
    path_outside_workspace: ["This file is outside the workspace", ""],
  } as Record<string, [string, string]>,
  sendFailed: "The message was not sent.",
  contextFailed: "ZCode did not accept the reference.",
  where: {
    page: (n: string) => `Page ${n}`,
    pages: (a: string, b: string) => `Pages ${a}–${b}`,
    pageLower: (n: string) => `page ${n}`,
    slide: (n: string) => `Slide ${n}`,
    slides: (a: string, b: string) => `Slides ${a}–${b}`,
    slideLower: (n: string) => `slide ${n}`,
    shape: (n: string) => `Slide ${n} · Shape`,
    paragraph: (n: string) => `Paragraph ${n}`,
    paragraphs: (a: string, b: string) => `Paragraphs ${a}–${b}`,
    paragraphLower: (n: string) => `paragraph ${n}`,
    table: (n: string) => `Table ${n}`,
    cell: (n: string, row: string, col: string) => `Table ${n} · R${row}C${col}`,
  },
};

const zh: typeof en = {
  title: PROFILE.title["zh-CN"],
  openTitle: "打开文档",
  openFile: "打开文件",
  emptyTitle: `打开你的 ${joinList(formats, "zh-CN")} 文件`,
  emptyDescription: `边看边聊，选中${selectable.zh}即可带入对话。`,
  emptyCaption: `选择本地文件 · ${extensionList("zh-CN", "or")}`,
  importing: "正在导入…",
  importTooLarge: `请选择不超过 ${MAX_FILE_BYTES / 1024 / 1024} MiB 的文件。`,

  recent: "最近",
  switchDocument: "切换文档",
  pagesAndOutline: "页面与目录",
  outlineOnly: "目录",
  pages: "页面",
  slides: "幻灯片",
  outline: "目录",
  find: "查找",
  findPlaceholder: "在文档中查找",
  findCount: (index, total) => `${index} / ${total}`,
  noResults: "无结果",
  previousMatch: "上一个（⇧Enter）",
  nextMatch: "下一个（Enter）",
  closeFind: "关闭（Esc）",
  more: "更多",
  fitWidth: "适应宽度",
  fitPage: "适应页面",
  actualSize: "实际大小",
  reload: "从磁盘重新加载",
  previousPage: "上一页",
  nextPage: "下一页",
  pageNumber: "页码",
  ofPages: (count) => `/ ${count}`,
  zoomIn: "放大（⌘+）",
  zoomOut: "缩小（⌘−）",
  fit: "适应",
  addToChat: "添加到对话",
  addShort: "添加",
  addToChatHint: "附加到下一条消息（⌘/Ctrl+Enter）",
  added: "已添加到对话",
  ask: "提问",
  askPlaceholder: "就这里提问…",
  send: "发送",
  cancel: "取消",
  sendKey: "发送",
  cancelKey: "取消",
  copy: "复制",
  copied: "已复制",
  agent: "Agent",
  agentOf: (index, total) => `Agent · 第 ${index} 处，共 ${total} 处`,
  nextTarget: "下一处",
  moreOn: (count, label) => (count === 1 ? `${label}还有 1 处` : `还有 ${count} 处`),
  close: "关闭",
  changed: "文件已在磁盘上更改。",
  reloadShort: "重新加载",
  dismiss: "忽略",
  openAnother: "打开其他文件",
  sidePanel: "在侧栏打开",
  meta: {
    pdf: (n) => `${n} 页`,
    pptx: (n) => `${n} 张幻灯片`,
    xlsx: (n) => `${n} 个工作表`,
    docx: () => "",
  },
  errors: {
    generic: ["无法打开该文档", ""],
    password: ["该 PDF 受密码保护", `${zhTitle}暂不支持打开加密文件。`],
    not_found: ["该文件已不存在", "它可能已被移动或删除。"],
    file_too_large: ["文件太大，无法打开", ""],
    corrupt_file: ["该文件似乎已损坏", `${zhTitle}无法读取其内容。`],
    unsupported_type: ["不支持这种文件", `${zhTitle}可以打开 ${extensionList("zh-CN")} 文件。`],
    path_outside_workspace: ["该文件不在工作区内", ""],
  },
  sendFailed: "消息未发送。",
  contextFailed: "ZCode 未接受该引用。",
  where: {
    page: (n) => `第 ${n} 页`,
    pages: (a, b) => `第 ${a}–${b} 页`,
    pageLower: (n) => `第 ${n} 页`,
    slide: (n) => `第 ${n} 张幻灯片`,
    slides: (a, b) => `第 ${a}–${b} 张幻灯片`,
    slideLower: (n) => `第 ${n} 张幻灯片`,
    shape: (n) => `第 ${n} 张幻灯片 · 形状`,
    paragraph: (n) => `第 ${n} 段`,
    paragraphs: (a, b) => `第 ${a}–${b} 段`,
    paragraphLower: (n) => `第 ${n} 段`,
    table: (n) => `表格 ${n}`,
    cell: (n, row, col) => `表格 ${n} · R${row}C${col}`,
  },
};

export type Strings = typeof en;
export const strings = (locale: string | undefined): Strings =>
  locale?.toLowerCase().startsWith("zh") ? zh : en;

/** A locator as people say it: `page:3` → "Page 3", `Plan!C2:D2` → "Plan · C2:D2". */
export function describeAt(at: string, t: Strings, lower = false): string {
  const w = t.where;
  let match: RegExpExecArray | null;
  if ((match = /^page:(\d+)(?:-(\d+))?$/.exec(at)))
    return match[2]
      ? w.pages(match[1], match[2])
      : lower
        ? w.pageLower(match[1])
        : w.page(match[1]);
  if ((match = /^slide:(\d+)\/shape:/.exec(at))) return w.shape(match[1]);
  if ((match = /^slide:(\d+)(?:-(\d+))?$/.exec(at)))
    return match[2]
      ? w.slides(match[1], match[2])
      : lower
        ? w.slideLower(match[1])
        : w.slide(match[1]);
  if ((match = /^p:(\d+)(?:-(\d+))?$/.exec(at)))
    return match[2]
      ? w.paragraphs(match[1], match[2])
      : lower
        ? w.paragraphLower(match[1])
        : w.paragraph(match[1]);
  if ((match = /^t:(\d+)\/r(\d+)c(\d+)$/.exec(at))) return w.cell(match[1], match[2], match[3]);
  if ((match = /^t:(\d+)$/.exec(at))) return w.table(match[1]);
  // Spreadsheet: Sheet!A1[:B2], with an optionally quoted sheet name.
  const bang = at.lastIndexOf("!");
  if (bang > 0)
    return `${at
      .slice(0, bang)
      .replace(/^'(.*)'$/, "$1")
      .replace(/''/g, "'")} · ${at.slice(bang + 1)}`;
  return at.replace(/^'(.*)'$/, "$1");
}
