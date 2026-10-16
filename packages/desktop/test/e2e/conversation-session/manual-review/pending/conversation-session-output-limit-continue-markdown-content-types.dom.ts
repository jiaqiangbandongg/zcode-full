import { TID_V4_TIMELINE } from "@zcode/shared";
import {
  AUTOLINK,
  CITATION_TARGET_PATH,
  EXTERNAL_LINK,
  LINK_TARGET_PATH,
  REFERENCE_LINK,
  type MarkdownContinueCaseId,
} from "./conversation-session-output-limit-continue-markdown-content-types.cases.js";

interface MarkdownAssistantRowSnapshot {
  inHistory: boolean;
  rowId: string | null;
  text: string;
}

interface MarkdownLinkSnapshot {
  tagName: string;
  text: string;
  title: string;
}

interface MarkdownImageSnapshot {
  alt: string;
  inGallery: boolean;
  loaded: boolean;
  src: string;
}

export interface MarkdownContinueSnapshot {
  assistantRows: MarkdownAssistantRowSnapshot[];
  blockquotes: string[];
  codeBlocks: Array<{ language: string; text: string }>;
  deletedTexts: string[];
  displayMathCount: number;
  emphasisTexts: string[];
  galleryCount: number;
  hardBreakCount: number;
  headings: Array<{ level: string; text: string }>;
  images: MarkdownImageSnapshot[];
  inlineCodeTexts: string[];
  inlineMathCount: number;
  links: MarkdownLinkSnapshot[];
  mermaidDiagramCount: number;
  orderedListCount: number;
  orderedListItems: string[];
  paragraphs: string[];
  rawCitationVisible: boolean;
  strongTexts: string[];
  tableRows: string[][];
  taskCheckboxes: Array<{ checked: boolean; disabled: boolean }>;
  thematicBreakCount: number;
  turnId: string | null;
  unorderedListCount: number;
  unorderedListItems: string[];
}

export function readMarkdownCaseSnapshot(userMarker: string): Promise<MarkdownContinueSnapshot> {
  return browser.execute(
    (timelineTestId, marker) => {
      const cleanText = (element: Element | null | undefined) =>
        (element?.textContent ?? "").replace(/\u00a0/g, " ").trim();
      const timeline = document.querySelector<HTMLElement>(`[data-testid="${timelineTestId}"]`);
      const userRow = Array.from(
        timeline?.querySelectorAll<HTMLElement>("[data-row-id]") ?? [],
      ).find(
        (row) =>
          row.classList.contains("group/user-row") &&
          (row.innerText || row.textContent || "").includes(marker),
      );
      const turn = userRow?.closest<HTMLElement>("[data-turn-id]") ?? null;
      const assistantRowElements = Array.from(
        turn?.querySelectorAll<HTMLElement>("[data-row-id]") ?? [],
      ).filter((row) => row.classList.contains("group/assistant-row"));
      const assistantRows = assistantRowElements.map((row) => ({
        inHistory: Boolean(row.closest("[data-slot='collapsible-content']")),
        rowId: row.getAttribute("data-row-id"),
        text: (row.innerText || row.textContent || "").replace(/\u00a0/g, " "),
      }));
      const assistantRow = assistantRowElements[0] ?? null;
      const unorderedLists = Array.from(
        assistantRow?.querySelectorAll<HTMLElement>('ul[data-markdown-list="unordered"]') ?? [],
      );
      const orderedLists = Array.from(
        assistantRow?.querySelectorAll<HTMLElement>('ol[data-markdown-list="ordered"]') ?? [],
      );
      const codeBlocks = Array.from(
        assistantRow?.querySelectorAll<HTMLElement>("div[data-language]") ?? [],
      ).filter((element) => !element.parentElement?.closest("div[data-language]"));
      const allMath = assistantRow?.querySelectorAll(".katex").length ?? 0;
      const displayMath = assistantRow?.querySelectorAll(".katex-display .katex").length ?? 0;

      // CodeViewer 会把高亮后的代码行放入 shadow root；只读 light DOM 会把完整代码误判为空。
      const readCodeLinesIncludingShadowRoots = (root: Element | ShadowRoot) => {
        const lines: string[] = [];

        const visit = (current: Element | ShadowRoot): void => {
          for (const element of current.querySelectorAll<HTMLElement>("*")) {
            if (element.matches("[data-line]")) {
              lines.push(element.textContent ?? "");
            }
            if (element.shadowRoot) {
              visit(element.shadowRoot);
            }
          }
        };

        visit(root);
        return lines.join("\n");
      };

      return {
        assistantRows,
        blockquotes: Array.from(assistantRow?.querySelectorAll("blockquote") ?? []).map(cleanText),
        codeBlocks: codeBlocks.map((element) => ({
          language: element.getAttribute("data-language") ?? "",
          text: readCodeLinesIncludingShadowRoots(element),
        })),
        deletedTexts: Array.from(assistantRow?.querySelectorAll("del") ?? []).map(cleanText),
        displayMathCount: displayMath,
        emphasisTexts: Array.from(assistantRow?.querySelectorAll("em") ?? []).map(cleanText),
        galleryCount: assistantRow?.querySelectorAll("[data-markdown-image-gallery]").length ?? 0,
        hardBreakCount: assistantRow?.querySelectorAll("p br").length ?? 0,
        headings: Array.from(
          assistantRow?.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6") ?? [],
        ).map((element) => ({ level: element.tagName, text: cleanText(element) })),
        images: Array.from(
          assistantRow?.querySelectorAll<HTMLImageElement>("img[data-markdown-image]") ?? [],
        ).map((image) => ({
          alt: image.alt,
          inGallery: Boolean(image.closest("[data-markdown-image-gallery]")),
          loaded: image.complete && image.naturalWidth > 0,
          src: image.src,
        })),
        inlineCodeTexts: Array.from(assistantRow?.querySelectorAll("code") ?? [])
          .filter((element) => !element.closest("div[data-language]"))
          .map(cleanText),
        inlineMathCount: Math.max(0, allMath - displayMath),
        links: Array.from(
          assistantRow?.querySelectorAll<HTMLElement>("button[title], span[title]") ?? [],
        )
          .map((element) => ({
            tagName: element.tagName,
            text: cleanText(element),
            title: element.getAttribute("title") ?? "",
          }))
          .filter((link) => link.text.length > 0),
        mermaidDiagramCount:
          assistantRow?.querySelectorAll('[data-mermaid-block] [role="img"]').length ?? 0,
        orderedListCount: orderedLists.length,
        orderedListItems: Array.from(
          assistantRow?.querySelectorAll<HTMLElement>(
            'ol[data-markdown-list="ordered"] li[data-streamdown="list-item"]',
          ) ?? [],
        ).map((element) => cleanText(element).replace(/\s+/gu, " ")),
        paragraphs: Array.from(assistantRow?.querySelectorAll("p") ?? []).map(cleanText),
        rawCitationVisible: cleanText(assistantRow).includes("zcode-file-citation"),
        strongTexts: Array.from(assistantRow?.querySelectorAll("strong") ?? []).map(cleanText),
        tableRows: Array.from(assistantRow?.querySelectorAll("table tr") ?? []).map((row) =>
          Array.from(row.querySelectorAll("th, td")).map(cleanText),
        ),
        taskCheckboxes: Array.from(
          assistantRow?.querySelectorAll<HTMLInputElement>('input[type="checkbox"]') ?? [],
        ).map((checkbox) => ({ checked: checkbox.checked, disabled: checkbox.disabled })),
        thematicBreakCount: assistantRow?.querySelectorAll("hr").length ?? 0,
        turnId: turn?.getAttribute("data-turn-id") ?? null,
        unorderedListCount: unorderedLists.length,
        unorderedListItems: Array.from(
          assistantRow?.querySelectorAll<HTMLElement>(
            'ul[data-markdown-list="unordered"] li[data-streamdown="list-item"]',
          ) ?? [],
        ).map((element) => cleanText(element).replace(/\s+/gu, " ")),
      };
    },
    TID_V4_TIMELINE,
    userMarker,
  );
}

export function isMarkdownCaseReady(
  id: MarkdownContinueCaseId,
  snapshot: MarkdownContinueSnapshot,
): boolean {
  if (snapshot.assistantRows.length !== 1) {
    return false;
  }
  if (id === "single-image") {
    return snapshot.images.length === 1 && snapshot.images[0]?.loaded === true;
  }
  if (id === "image-gallery") {
    return (
      snapshot.galleryCount === 1 &&
      snapshot.images.length === 2 &&
      snapshot.images.every((image) => image.loaded)
    );
  }
  if (id === "mermaid") {
    return snapshot.mermaidDiagramCount === 1;
  }
  if (id === "zcode-file-citation" || id === "workspace-file-link") {
    return snapshot.links.some((link) => link.tagName === "BUTTON");
  }
  return true;
}

export function assertMarkdownCase(id: MarkdownContinueCaseId, snapshot: MarkdownContinueSnapshot) {
  switch (id) {
    case "paragraph":
      expect(snapshot.paragraphs).toContain(
        "段落在 Continue 中途截断后自然拼接完成。 PARAGRAPH_DONE",
      );
      return;
    case "newline-after-partial":
      expect(snapshot.paragraphs).toContain(
        "第一行在 partial 末尾。\n第二行从 continuation 开始。 NEWLINE_AFTER_PARTIAL_DONE",
      );
      expect(snapshot.hardBreakCount).toBe(0);
      return;
    case "soft-break-at-continue-start":
      expect(snapshot.paragraphs).toContain("软换行第一行\n软换行第二行。 SOFT_BREAK_DONE");
      expect(snapshot.hardBreakCount).toBe(0);
      return;
    case "hard-break":
      expect(snapshot.paragraphs).toContain("硬换行第一行\n硬换行第二行。 HARD_BREAK_DONE");
      expect(snapshot.hardBreakCount).toBe(1);
      return;
    case "heading":
      expect(snapshot.headings).toEqual([{ level: "H2", text: "Continue 标题完整 HEADING_DONE" }]);
      return;
    case "blockquote":
      expect(snapshot.blockquotes).toContain("引用内容跨越断点。 BLOCKQUOTE_DONE");
      return;
    case "unordered-list":
      expect(snapshot.unorderedListCount).toBe(1);
      expect(snapshot.unorderedListItems).toContain("bullet 项跨越断点。 UNORDERED_LIST_DONE");
      return;
    case "ordered-list":
      expect(snapshot.orderedListCount).toBe(1);
      expect(snapshot.orderedListItems).toContain("ordered 项跨越断点。 ORDERED_LIST_DONE");
      return;
    case "task-list":
      expect(snapshot.unorderedListItems).toContain("task 项跨越断点。 TASK_LIST_DONE");
      expect(snapshot.taskCheckboxes).toEqual([{ checked: true, disabled: true }]);
      return;
    case "nested-list":
      expect(snapshot.unorderedListCount).toBe(2);
      expect(snapshot.unorderedListItems).toContain("子项跨越断点。 NESTED_LIST_DONE");
      return;
    case "thematic-break":
      expect(snapshot.thematicBreakCount).toBe(1);
      expect(snapshot.paragraphs).toContain("THEMATIC_BREAK_DONE");
      return;
    case "fenced-code":
      expect(snapshot.codeBlocks).toHaveLength(1);
      expect(snapshot.codeBlocks[0]?.language).toBe("ts");
      expect(snapshot.codeBlocks[0]?.text).toContain('const partial = "P1";');
      expect(snapshot.codeBlocks[0]?.text).toContain('const continuation = "P2";');
      expect(snapshot.assistantRows[0]?.text).not.toContain("```ts");
      return;
    case "table":
      expect(snapshot.tableRows).toEqual([
        ["列 A", "列 B"],
        ["partial", "continuation"],
      ]);
      return;
    case "emphasis":
      expect(snapshot.emphasisTexts).toEqual(["斜体跨越断点"]);
      return;
    case "strong":
      expect(snapshot.strongTexts).toEqual(["粗体跨越断点"]);
      return;
    case "strikethrough":
      expect(snapshot.deletedTexts).toEqual(["删除线跨越断点"]);
      return;
    case "inline-code":
      expect(snapshot.inlineCodeTexts).toContain("inline-continue");
      return;
    case "external-link":
      expect(snapshot.links).toContainEqual({
        tagName: "BUTTON",
        text: "外部链接跨越断点",
        title: EXTERNAL_LINK,
      });
      return;
    case "workspace-file-link":
      expect(snapshot.links).toContainEqual({
        tagName: "BUTTON",
        text: "工作区文件跨越断点",
        title: LINK_TARGET_PATH,
      });
      return;
    case "reference-link":
      expect(snapshot.links).toContainEqual({
        tagName: "BUTTON",
        text: "引用式链接",
        title: REFERENCE_LINK,
      });
      return;
    case "autolink":
      expect(snapshot.links).toContainEqual({
        tagName: "BUTTON",
        text: AUTOLINK,
        title: AUTOLINK,
      });
      return;
    case "single-image":
      expect(snapshot.galleryCount).toBe(0);
      expect(snapshot.images).toHaveLength(1);
      expect(snapshot.images[0]?.alt).toBe("单图跨越断点");
      expect(snapshot.images[0]?.inGallery).toBe(false);
      expect(snapshot.images[0]?.src).toMatch(/^data:image\/svg\+xml;base64,/u);
      return;
    case "image-gallery":
      expect(snapshot.galleryCount).toBe(1);
      expect(snapshot.images.map((image) => image.alt)).toEqual(["画廊一", "画廊二"]);
      expect(snapshot.images.every((image) => image.inGallery)).toBe(true);
      return;
    case "inline-math":
      expect(snapshot.inlineMathCount).toBeGreaterThanOrEqual(1);
      expect(snapshot.displayMathCount).toBe(0);
      return;
    case "display-math":
      expect(snapshot.displayMathCount).toBe(1);
      return;
    case "mermaid":
      expect(snapshot.mermaidDiagramCount).toBe(1);
      expect(snapshot.assistantRows[0]?.text).not.toContain("```mermaid");
      return;
    case "zcode-file-citation":
      expect(snapshot.rawCitationVisible).toBe(false);
      expect(snapshot.links).toContainEqual({
        tagName: "BUTTON",
        text: "citation.txt",
        title: CITATION_TARGET_PATH,
      });
      return;
  }
}
