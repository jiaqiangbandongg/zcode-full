import { createElement, type HTMLAttributes, type ReactNode } from "react";
import { Marked } from "marked";
import type { CloudContentDialogPayload } from "@/components/cloud-content-dialog/cloudContentDialogTypes.js";
import { cn } from "@/components/lib/utils.js";
import { parseCloudDescriptionStyle } from "@/components/cloud-content-dialog/cloudDescriptionStyle.js";

const TAGS = new Set([
  "p",
  "br",
  "b",
  "strong",
  "i",
  "em",
  "u",
  "s",
  "ul",
  "ol",
  "li",
  "code",
  "a",
  "span",
  "time",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "pre",
  "hr",
  "del",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
]);
const CLASSES: Record<string, string> = {
  b: "font-semibold text-foreground",
  strong: "font-semibold text-foreground",
  ul: "list-disc pl-5",
  ol: "list-decimal pl-5",
  code: "font-mono text-ui-sm",
  a: "text-icon-blue underline underline-offset-4",
  time: "whitespace-nowrap font-semibold text-foreground underline decoration-foreground-subtle decoration-dashed underline-offset-4",
  h1: "text-ui-xl font-semibold",
  h2: "text-ui-lg font-semibold",
  h3: "text-ui-base font-semibold",
  h4: "text-ui-base font-semibold",
  h5: "text-ui-base font-medium",
  h6: "text-ui-base font-normal",
  blockquote: "border-l border-border pl-3",
  pre: "overflow-x-auto whitespace-pre-wrap font-mono text-ui-sm",
  table: "w-full text-ui-base",
  th: "border border-border p-2 font-semibold",
  td: "border border-border p-2",
};

const BLOCK_TAGS = new Set([
  "p",
  "ul",
  "ol",
  "li",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "pre",
  "hr",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
]);
const markdown = new Marked({
  async: false,
  renderer: {
    // Markdown 内嵌 HTML 作为文字；显式 html format 才进入 HTML 解析路径。
    html: ({ text }) =>
      text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"),
  },
});

function safeLink(value: string | null): string | undefined {
  if (!value || !/^https?:\/\//i.test(value)) return undefined;
  try {
    const url = new URL(value);
    return url.username || url.password ? undefined : url.href;
  } catch {
    return undefined;
  }
}

function renderHtml(
  text: string,
  onOpenExternal?: (url: string) => void,
  inline = false,
): ReactNode {
  if (text.length > 20_000 || typeof document === "undefined") return text;
  // 云端 HTML 只在 inert template 内解析，不能把其 DOM 或属性直接带入宿主。
  const template = document.createElement("template");
  template.innerHTML = text;
  let overDepth = false;
  function visit(node: Node, depth: number, key: number): ReactNode {
    if (depth > 32) {
      overDepth = true;
      return null;
    }
    if (node.nodeType === 3) return node.textContent;
    if (node.nodeType !== 1) return null;
    const element = node as Element;
    const tag = element.localName;
    if (element.namespaceURI !== "http://www.w3.org/1999/xhtml" || !TAGS.has(tag)) return null;
    const children = Array.from(element.childNodes, (child, index) =>
      visit(child, depth + 1, index),
    );
    const props = {
      key,
      className: cn(
        inline ? (tag === "b" || tag === "strong" ? "font-semibold" : undefined) : CLASSES[tag],
        element.getAttribute("class"),
      ),
      style: parseCloudDescriptionStyle(element.getAttribute("style")),
    };
    if (tag === "a") {
      const href = safeLink(element.getAttribute("href"));
      if (!href || !onOpenExternal)
        return createElement(
          "span",
          { ...props, className: element.getAttribute("class") ?? undefined },
          children,
        );
      return createElement(
        "a",
        {
          ...props,
          href,
          title: element.getAttribute("title") ?? undefined,
          onClick: (event: React.MouseEvent) => {
            event.preventDefault();
            onOpenExternal(href);
          },
        },
        children,
      );
    }
    // 标题/按钮不能嵌套块级或交互节点；保留行内排版且沿用宿主动作。
    return createElement(
      inline && BLOCK_TAGS.has(tag) ? "span" : tag,
      props,
      tag === "br" || tag === "hr" ? undefined : children,
    );
  }
  const result = Array.from(template.content.childNodes, (child, index) => visit(child, 0, index));
  return overDepth ? text : result;
}

export function CloudFormattedTextContent({
  text,
  inline = false,
  onOpenExternal,
}: {
  text: CloudContentDialogPayload["dialog"]["description"];
  inline?: boolean;
  onOpenExternal?: (url: string) => void;
}) {
  if (text.format === "plain_text" || text.text.length > 20_000) return text.text;
  const html =
    text.format === "markdown" ? markdown.parse(text.text, { async: false }).trimEnd() : text.text;
  return renderHtml(html, inline ? undefined : onOpenExternal, inline);
}

export function CloudDialogDescription({
  description,
  onOpenExternal,
  ...props
}: {
  description: CloudContentDialogPayload["dialog"]["description"];
  onOpenExternal?: (url: string) => void;
} & HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...props} data-description-format={description.format}>
      <CloudFormattedTextContent text={description} onOpenExternal={onOpenExternal} />
    </div>
  );
}
