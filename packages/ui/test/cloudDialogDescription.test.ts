// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudDialogDescription } from "@/components/cloud-content-dialog/CloudDialogDescription.js";

afterEach(cleanup);

describe("简单 HTML 描述", () => {
  it("renders Markdown structure and rejects embedded active content", () => {
    const { container } = render(
      createElement(CloudDialogDescription, {
        description: {
          format: "markdown",
          text: "## 标题\n\n**强调** 与 `代码`\n\n- 第一项\n- 第二项\n\n<script>bad()</script>\n\n![image](https://example.com/a.png)",
        },
      }),
    );
    expect(container.querySelector("h2")?.textContent).toBe("标题");
    expect(container.querySelector("strong")?.textContent).toBe("强调");
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(container.querySelector("script,img")).toBeNull();
  });
  it.each([
    "color:rgb(20, 30, 40)",
    "background-color:#abcdef",
    "font-style:italic",
    "font-size:var(--text-ui-lg)",
    "font-weight:500",
    "line-height:1.5",
    "text-align:center",
    "white-space:nowrap",
    "overflow-wrap:anywhere",
    "word-break:break-all",
    "text-decoration:underline dashed",
    "text-decoration-line:underline",
    "text-decoration-style:dotted",
    "text-decoration-color:var(--color-foreground-subtle)",
    "text-decoration-thickness:2px",
    "text-underline-offset:4px",
    "letter-spacing:1px",
    "padding:2px 4px",
    "margin-left:1rem",
  ])("保留合法排版 %s", (style) => {
    const { container } = render(
      createElement(CloudDialogDescription, {
        description: { format: "html", text: `<span style="${style}">内容</span>` },
      }),
    );
    expect(container.querySelector("span")!.getAttribute("style")).toBeTruthy();
  });

  it("链接降级为文字时仍保留 class 和合法 style", () => {
    const { container } = render(
      createElement(CloudDialogDescription, {
        description: {
          format: "html",
          text: '<a href="https://example.com" class="font-semibold unknown" style="margin-left:8px">链接</a>',
        },
      }),
    );
    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelector("span")!.className).toBe("font-semibold unknown");
    expect(container.querySelector("span")!.style.marginLeft).toBe("8px");
  });
  it("保留基础排版和安全链接，点击交给宿主", () => {
    const openExternal = vi.fn();
    const { container } = render(
      createElement(CloudDialogDescription, {
        description: {
          format: "html",
          text: '<p>你好 <b>权益</b><br><em>说明</em></p><ul><li><code>code</code></li></ul><a href="https://example.com/help" title="帮助">帮助</a>',
        },
        onOpenExternal: openExternal,
      }),
    );
    expect(container.querySelector("b")?.textContent).toBe("权益");
    expect(container.querySelector("li code")?.textContent).toBe("code");
    fireEvent.click(screen.getByRole("link"));
    expect(openExternal).toHaveBeenCalledWith("https://example.com/help");
  });

  it("删除可执行内容、危险样式和危险链接，但保留未知 class", () => {
    const { container } = render(
      createElement(CloudDialogDescription, {
        description: {
          format: "html",
          text: '<script>alert(1)</script><iframe src="https://example.com"></iframe><svg onload="alert(1)"><a>SVG</a></svg><img src=x onerror="alert(1)"><p style="position:fixed" class="bad" id="bad" onclick="alert(1)">保留</p><a href="java&#x73;cript:alert(1)">危险</a><a href="data:text/html,test">data</a><a href="//example.com">relative</a>',
        },
        onOpenExternal: vi.fn(),
      }),
    );
    expect(container.querySelector("script,iframe,svg,img,[style],[onclick],[id=bad]")).toBeNull();
    expect(container.querySelector(".bad")?.textContent).toBe("保留");
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toContain("保留");
    expect(container.textContent).not.toContain("alert");
  });

  it("合并 Tailwind 类且保留允许的 inline style，删除危险声明", () => {
    const { container } = render(
      createElement(CloudDialogDescription, {
        description: {
          format: "html",
          text: '<p class="text-center text-ui-base/relaxed remote-unknown" style="margin:8px 1rem;position:fixed;background-image:url(https://example.com);--custom:red"><b class="font-normal" style="font-weight:600;color:var(--color-foreground);font-size:var(--text-ui-base)">模型</b><span class="whitespace-nowrap font-semibold text-foreground underline decoration-foreground-subtle decoration-dashed underline-offset-4" style="text-decoration:underline dashed;text-underline-offset:4px">日期</span></p>',
        },
      }),
    );
    const p = container.querySelector("p")!;
    expect(p.classList.contains("remote-unknown")).toBe(true);
    expect(p.style.margin).toBe("8px 1rem");
    expect(p.style.position).toBe("");
    expect(p.style.backgroundImage).toBe("");
    expect(p.style.getPropertyValue("--custom")).toBe("");
    const b = container.querySelector("b")!;
    expect(b.classList.contains("font-normal")).toBe(true);
    expect(b.classList.contains("font-semibold")).toBe(false);
    expect(b.style.fontWeight).toBe("600");
    expect(b.style.color).toBe("var(--color-foreground)");
    expect(b.style.fontSize).toBe("var(--text-ui-base)");
    expect(container.querySelector("span")!.style.textUnderlineOffset).toBe("4px");
  });

  it.each([
    "margin:-1px",
    "padding:99999px",
    "color:var(--unknown)",
    "color:var(--color-foreground,red)",
    "font-size:90px",
    "line-height:999",
    "font-weight:600!important",
    "text-decoration:underline url(x)",
    "letter-spacing:calc(1px + 2px)",
  ])("拒绝不支持的样式 %s", (style) => {
    const { container } = render(
      createElement(CloudDialogDescription, {
        description: { format: "html", text: `<span style="${style}">内容</span>` },
      }),
    );
    expect(container.querySelector("span")!.getAttribute("style")).toBeNull();
  });

  it("纯文本与 Markdown 内嵌 HTML 不解释为 HTML", () => {
    for (const format of ["plain_text", "markdown"] as const) {
      const { container, unmount } = render(
        createElement(CloudDialogDescription, {
          description: { format, text: "<b>literal</b>" },
        }),
      );
      expect(container.querySelector("b")).toBeNull();
      expect(container.textContent).toBe("<b>literal</b>");
      unmount();
    }
  });

  it("无平台回调时链接为文字，超限内容退化为纯文本", () => {
    const { container, rerender } = render(
      createElement(CloudDialogDescription, {
        description: { format: "html", text: '<a href="https://example.com">帮助</a>' },
      }),
    );
    expect(container.querySelector("a")).toBeNull();
    const text = "<b>" + "x".repeat(20_000) + "</b>";
    rerender(createElement(CloudDialogDescription, { description: { format: "html", text } }));
    expect(container.querySelector("b")).toBeNull();
    expect(container.textContent).toBe(text);
    const deep = "<span>".repeat(40) + "text" + "</span>".repeat(40);
    rerender(
      createElement(CloudDialogDescription, { description: { format: "html", text: deep } }),
    );
    expect(container.querySelector("span")).toBeNull();
    expect(container.textContent).toBe(deep);
  });
});
