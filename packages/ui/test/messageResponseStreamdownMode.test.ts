import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  buildMessageFileLinkTarget,
  buildMessageStreamdownRenderKey,
  messageResponsePropsAreEqual,
  MessageResponse,
  openMessageFileLinkInEditor,
  resolveMessageStreamdownMode,
} from "@/components/ai-elements/message.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";

vi.mock("@/store/StoreProvider.js", () => ({
  useZCodeStore: (selector: (state: unknown) => unknown) =>
    selector({
      codePreviewSettings: {
        darkTheme: "github-dark",
        fontSizePx: 13,
        lightTheme: "github-light",
        wrapLongLines: true,
      },
      theme: "zai-light",
    }),
}));

vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => ({
    getInstalledEditors: vi.fn().mockResolvedValue([]),
    openInEditor: vi.fn().mockResolvedValue({ success: true }),
    openInFileManager: vi.fn().mockResolvedValue({ success: true }),
  }),
  useOptionalPlatform: () => ({
    getInstalledEditors: vi.fn().mockResolvedValue([]),
    openInEditor: vi.fn().mockResolvedValue({ success: true }),
    openInFileManager: vi.fn().mockResolvedValue({ success: true }),
  }),
}));

describe("resolveMessageStreamdownMode", () => {
  it("invalidates memoized artifact images when their session or reader changes", () => {
    const readAttachment = vi.fn();
    const base = {
      children: "![CUA](zcode-artifact://session-1/shot)",
      sessionId: "session-1",
      readAttachment,
    };

    expect(messageResponsePropsAreEqual(base, base)).toBe(true);
    expect(messageResponsePropsAreEqual(base, { ...base, sessionId: "session-2" })).toBe(false);
    expect(messageResponsePropsAreEqual(base, { ...base, readAttachment: vi.fn() })).toBe(false);
  });

  it("保留 Markdown 目录链接的 pathKind 和远程 workspace scope", () => {
    expect(
      buildMessageFileLinkTarget({
        href: "./src/",
        label: "src",
        path: "/workspace/repo/src/",
        workspacePath: "/workspace/repo",
        workspaceIdentity: "remote:wsl:Ubuntu:/workspace/repo",
        workspaceRemoteSessionId: "wsl-session",
      }),
    ).toEqual({
      path: "/workspace/repo/src/",
      label: "src",
      pathKind: "directory",
      relativePath: "src",
      workspacePath: "/workspace/repo",
      workspaceIdentity: "remote:wsl:Ubuntu:/workspace/repo",
      workspaceRemoteSessionId: "wsl-session",
    });
  });

  it.each([
    ["./src/App.tsx", "/workspace/repo/src/App.tsx"],
    ["./config", "/workspace/repo/config"],
    ["/etc/hosts", "/etc/hosts"],
  ])("Markdown 文件链接 %s 不在渲染阶段猜测文件系统类型", (href, path) => {
    expect(
      buildMessageFileLinkTarget({
        href,
        label: "file",
        path,
        workspacePath: "/workspace/repo",
      }).pathKind,
    ).toBeUndefined();
  });

  it.each(["file", "directory"] as const)(
    "Markdown 打开方式通过 workspace stat 传递真实 %s 类型",
    async (type) => {
      const statFile = vi.fn().mockResolvedValue({ type });
      const openInEditor = vi.fn().mockResolvedValue({ success: true });
      const fileLink = buildMessageFileLinkTarget({
        href: "./config",
        label: "config",
        path: "/workspace/repo/config",
        workspacePath: "/workspace/repo",
        workspaceIdentity: "remote:wsl:Ubuntu:/workspace/repo",
      });
      const remoteTarget = { kind: "wsl" as const, distro: "Ubuntu" };

      await expect(
        openMessageFileLinkInEditor({
          editorId: "vscode",
          fileLink,
          openInEditor,
          remoteTarget,
          statFile,
        }),
      ).resolves.toEqual({ success: true });

      expect(statFile).toHaveBeenCalledWith({ path: "/workspace/repo/config" });
      expect(openInEditor).toHaveBeenCalledWith("vscode", "/workspace/repo/config", {
        pathKind: type,
        remoteTarget,
        workspaceIdentity: "remote:wsl:Ubuntu:/workspace/repo",
      });
    },
  );

  it("Markdown 打开方式 stat 失败时不调用本机编辑器", async () => {
    const statFile = vi.fn().mockRejectedValue(new Error("path not found"));
    const openInEditor = vi.fn();
    const fileLink = buildMessageFileLinkTarget({
      href: "./config",
      label: "config",
      path: "/workspace/repo/config",
      workspacePath: "/workspace/repo",
    });

    await expect(
      openMessageFileLinkInEditor({
        editorId: "vscode",
        fileLink,
        openInEditor,
        statFile,
      }),
    ).rejects.toThrow("path not found");
    expect(openInEditor).not.toHaveBeenCalled();
  });

  it("越界相对 Markdown 链接不生成可点击文件操作目标", () => {
    const html = renderToStaticMarkup(
      createElement(
        MessageResponse,
        {
          workspacePath: "/workspace",
          onOpenFileLink: vi.fn(),
        },
        "[private](foo/../../private.pdf)",
      ),
    );

    expect(html).toContain("private");
    expect(html).not.toContain("/workspace/foo/../../private.pdf");
    expect(html).not.toContain("cursor-pointer");
  });

  it("Assistant citation 使用现有文件链接渲染，普通文件名仍保持原文", () => {
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(
          MessageResponse,
          {
            renderZCodeFileCitations: true,
            workspacePath: "/workspace",
            onOpenFileLink: vi.fn(),
          },
          [
            "普通文件 report.pdf。",
            ':zcode-file-citation{path="docs/年度 报告.pdf" purpose="output" page_number=2}',
            ':::zcode-file-citation{path="docs/论文.pdf" purpose="source"}',
          ].join("\n\n"),
        ),
      ),
    );

    expect(html).toContain("普通文件 report.pdf");
    expect(html).not.toContain(":zcode-file-citation");
    expect(html).toContain("<button");
    expect(html).toContain('title="/workspace/docs/年度 报告.pdf"');
    expect(html).toContain('title="/workspace/docs/论文.pdf"');
    expect(html).toContain("年度 报告.pdf");
  });

  it("citation 和 Markdown 文件链接支持智能引号且不污染路径", () => {
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(
          MessageResponse,
          {
            renderZCodeFileCitations: true,
            workspacePath: "/workspace",
            onOpenFileLink: vi.fn(),
          },
          [
            '规划完成。已生成 ：:zcode-file-citation{path=“/workspace/冰岛 行程.pdf” purpose="output"}',
            "[说明](‘docs/说明.md’)",
          ].join("\n\n"),
        ),
      ),
    );

    expect(html).toContain('title="/workspace/冰岛 行程.pdf"');
    expect(html).toContain('title="/workspace/docs/说明.md"');
    expect(html).not.toContain("/workspace/“");
    expect(html).not.toContain("说明.md’");
    expect(html).not.toContain("[blocked]");
  });

  it("正文文件链接由文字提供真实基线，图标独立居中，并仅在 hover 显示虚线下划线", () => {
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(
          MessageResponse,
          {
            workspacePath: "/workspace",
            onOpenFileLink: vi.fn(),
          },
          "[项目交付稿](docs/项目交付稿.pptx)",
        ),
      ),
    );

    expect(html).toContain("text-icon-blue");
    expect(html).toContain("gap-1");
    expect(html).not.toContain("gap-1.5");
    expect(html).toContain("ml-0.5");
    expect(html).toContain("items-baseline");
    expect(html).toContain("self-center");
    expect(html).toContain("self-baseline");
    expect(html).not.toContain("items-center");
    expect(html).not.toContain("top-px");
    expect(html).toContain("align-baseline");
    expect(html).not.toContain("align-middle");
    expect(html).toContain("no-underline");
    expect(html).toContain("decoration-dotted");
    expect(html).not.toContain("decoration-dashed");
    expect(html).toContain("hover:underline");
    expect(html).not.toContain("hover:no-underline");
  });

  it("正文公网链接与文件链接使用相同的浏览器式链接交互", () => {
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(
          MessageResponse,
          { onOpenExternalUrl: vi.fn() },
          "[ZCode](https://zcode-ai.com)",
        ),
      ),
    );

    expect(html).toContain("text-icon-blue");
    expect(html).toContain("no-underline");
    expect(html).toContain("decoration-dotted");
    expect(html).not.toContain("decoration-dashed");
    expect(html).toContain("hover:underline");
  });

  it("streaming 时隐藏未闭合 citation，异常换行后的正文仍可见", () => {
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(
          MessageResponse,
          {
            renderZCodeFileCitations: true,
            streaming: true,
            workspacePath: "/workspace",
            onOpenFileLink: vi.fn(),
          },
          '正文\n::zcode-file-citation{path="docs/report.pdf"',
        ),
      ),
    );
    expect(html).toContain("正文");
    expect(html).not.toContain("::zcode-file-citation");

    const malformedHtml = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(
          MessageResponse,
          {
            renderZCodeFileCitations: true,
            streaming: true,
            workspacePath: "/workspace",
            onOpenFileLink: vi.fn(),
          },
          '正文\n::zcode-file-citation{path="docs/report.pdf"\n后续说明仍然可见',
        ),
      ),
    );
    expect(malformedHtml).toContain("后续说明仍然可见");
  });

  it.each([
    ["盘符路径", String.raw`C:\Users\demo\年度 报告.pdf`, "C:/Users/demo/年度 报告.pdf"],
    ["Windows file URL", "file:///C:/Users/demo/report.pdf", "C:/Users/demo/report.pdf"],
  ])("Assistant citation 的 Windows %s 通过 harden 后仍可点击", (_case, path, resolvedPath) => {
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(
          MessageResponse,
          {
            renderZCodeFileCitations: true,
            workspacePath: "C:\\workspace",
            onOpenFileLink: vi.fn(),
          },
          `::zcode-file-citation{path="${path}" purpose="output"}`,
        ),
      ),
    );

    expect(html).not.toContain("[blocked]");
    expect(html).toContain("<button");
    expect(html).toContain(`title="${resolvedPath}"`);
  });

  it("越界 citation 保持原文且不生成文件链接", () => {
    const directive = '::zcode-file-citation{path="foo/../../private.pdf"}';
    const html = renderToStaticMarkup(
      createElement(
        MessageResponse,
        {
          renderZCodeFileCitations: true,
          workspacePath: "/workspace",
          onOpenFileLink: vi.fn(),
        },
        directive,
      ),
    );

    expect(html).toContain("::zcode-file-citation");
    expect(html).not.toContain('title="/workspace/foo/../../private.pdf"');
  });

  it("citation 不解析代码节点，并保留 Streamdown 默认 GFM 表格", () => {
    const directive = '::zcode-file-citation{path="docs/report.pdf"}';
    const compatibilityDirective = ':zcode-file-citation{path="docs/legacy.pdf"}';
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(
          TooltipProvider,
          null,
          createElement(
            MessageResponse,
            {
              renderZCodeFileCitations: true,
              workspacePath: "/workspace",
              onOpenFileLink: vi.fn(),
            },
            [
              `\`${directive}\``,
              `\`${compatibilityDirective}\``,
              "",
              "| 文件 | 状态 |",
              "| --- | --- |",
              "| report.pdf | 完成 |",
            ].join("\n"),
          ),
        ),
      ),
    );

    expect(html).toContain("::zcode-file-citation");
    expect(html).toContain(":zcode-file-citation");
    expect(html).toContain("<table");
    expect(html).not.toContain('title="/workspace/docs/report.pdf"');
    expect(html).not.toContain('title="/workspace/docs/legacy.pdf"');
  });

  it.each([
    ["盘符正斜杠", "[报告](C:/Users/demo/report.md)", "C:/Users/demo/report.md"],
    ["盘符反斜杠", String.raw`[报告](C:\Users\demo\report.md)`, "C:/Users/demo/report.md"],
    ["Windows file URL", "[报告](file:///C:/Users/demo/report.md)", "C:/Users/demo/report.md"],
    [
      "中文空格路径",
      "[报告](<C:/Users/demo/中文 目录/report.md>)",
      "C:/Users/demo/中文 目录/report.md",
    ],
  ])("Windows 绝对 Markdown 链接（%s）通过 harden 后仍可点击", (_case, markdown, path) => {
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(
          MessageResponse,
          {
            workspacePath: "C:\\workspace",
            onOpenFileLink: vi.fn(),
          },
          markdown,
        ),
      ),
    );

    expect(html).not.toContain("[blocked]");
    expect(html).toContain("<button");
    expect(html).toContain(`title="${path}"`);
  });

  it("UNC workspace 中 Windows 绝对 Markdown 链接通过 harden 后仍可点击", () => {
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(
          MessageResponse,
          {
            workspacePath: "\\\\server\\share\\repo",
            onOpenFileLink: vi.fn(),
          },
          "[报告](C:/Users/demo/report.md)",
        ),
      ),
    );

    expect(html).not.toContain("[blocked]");
    expect(html).toContain("<button");
    expect(html).toContain('title="C:/Users/demo/report.md"');
  });

  it.each([
    ["盘符正斜杠", "![截图](C:/Users/demo/screenshot.png)"],
    ["盘符反斜杠", String.raw`![截图](C:\Users\demo\screenshot.png)`],
    ["Windows file URL", "![截图](file:///C:/Users/demo/screenshot.png)"],
  ])("Windows 绝对 Markdown 图片（%s）通过 harden 后保留本地路径", (_case, markdown) => {
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(MessageResponse, { workspacePath: "C:\\workspace" }, markdown),
      ),
    );

    expect(html).not.toContain("[blocked]");
    expect(html).toContain('data-markdown-local-image="loading"');
    expect(html).toContain('title="C:/Users/demo/screenshot.png"');
  });

  it("UNC workspace 中 Windows 绝对 Markdown 图片通过 harden 后保留本地路径", () => {
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(
          MessageResponse,
          { workspacePath: "\\\\server\\share\\repo" },
          "![截图](C:/Users/demo/screenshot.png)",
        ),
      ),
    );

    expect(html).not.toContain("[blocked]");
    expect(html).toContain('data-markdown-local-image="loading"');
    expect(html).toContain('title="C:/Users/demo/screenshot.png"');
  });

  it("正文裸文件名保持普通文本且 GFM 表格正常渲染", () => {
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(
          TooltipProvider,
          null,
          createElement(
            MessageResponse,
            {
              workspacePath: "/workspace",
            },
            [
              "| 项 | 状态 |",
              "| --- | --- |",
              "| Word 文档 | ✅ |",
              "",
              "已生成 report.docx。",
            ].join("\n"),
          ),
        ),
      ),
    );

    expect(html).toContain("<table");
    expect(html).toContain("已生成 report.docx。");
    expect(html).not.toMatch(/title="[^"]*report\.docx"/);
  });

  it.each([false, true])("仅双波浪线渲染删除线（streaming=%s）", (streaming) => {
    const html = renderToStaticMarkup(
      createElement(
        MessageResponse,
        { streaming, workspacePath: "/workspace" },
        "~单波浪线~ 与 ~~双波浪线。~~后续文字",
      ),
    );

    expect(html).toContain("~单波浪线~");
    expect(html).not.toContain("<del>单波浪线</del>");
    expect(html).toContain("<del>双波浪线。</del>后续文字");
  });

  it("keeps completed messages on Streamdown static mode", () => {
    expect(resolveMessageStreamdownMode(false)).toBe("static");
  });

  it("uses Streamdown streaming mode only while the message is actively streaming", () => {
    expect(resolveMessageStreamdownMode(true)).toBe("streaming");
  });

  it("changes the Streamdown render key when code block rendering settings change", () => {
    const base = buildMessageStreamdownRenderKey({
      codeBlockTheme: "github-light",
      fontSizePx: 12,
      workspacePath: "/workspace",
      wrapLongLines: false,
    });

    expect(
      buildMessageStreamdownRenderKey({
        codeBlockTheme: "github-dark",
        fontSizePx: 12,
        workspacePath: "/workspace",
        wrapLongLines: false,
      }),
    ).not.toBe(base);
    expect(
      buildMessageStreamdownRenderKey({
        codeBlockTheme: "github-light",
        fontSizePx: 13,
        workspacePath: "/workspace",
        wrapLongLines: false,
      }),
    ).not.toBe(base);
    expect(
      buildMessageStreamdownRenderKey({
        codeBlockTheme: "github-light",
        fontSizePx: 12,
        workspacePath: "/workspace",
        wrapLongLines: true,
      }),
    ).not.toBe(base);
  });

  it("keeps the Streamdown render key stable across streaming mode changes", () => {
    const staticModeKey = buildMessageStreamdownRenderKey({
      codeBlockTheme: "github-light",
      fontSizePx: 12,
      workspacePath: "/workspace",
      wrapLongLines: false,
    });
    const streamingModeKey = buildMessageStreamdownRenderKey({
      codeBlockTheme: "github-light",
      fontSizePx: 12,
      workspacePath: "/workspace",
      wrapLongLines: false,
    });

    expect(streamingModeKey).toBe(staticModeKey);
  });

  it("changes the Streamdown render key with artifact permission context", () => {
    const base = buildMessageStreamdownRenderKey({
      attachmentReaderEpoch: 1,
      codeBlockTheme: "github-light",
      fontSizePx: 12,
      sessionId: "session-a",
      workspacePath: "/workspace",
      wrapLongLines: false,
    });

    expect(
      buildMessageStreamdownRenderKey({
        attachmentReaderEpoch: 1,
        codeBlockTheme: "github-light",
        fontSizePx: 12,
        sessionId: "session-b",
        workspacePath: "/workspace",
        wrapLongLines: false,
      }),
    ).not.toBe(base);
    expect(
      buildMessageStreamdownRenderKey({
        attachmentReaderEpoch: 2,
        codeBlockTheme: "github-light",
        fontSizePx: 12,
        sessionId: "session-a",
        workspacePath: "/workspace",
        wrapLongLines: false,
      }),
    ).not.toBe(base);
  });

  it("renders single-dollar inline math as KaTeX", () => {
    const html = renderToStaticMarkup(
      createElement(
        MessageResponse,
        { workspacePath: "/workspace" },
        "其中 $c(\\mathbf{r})$ 是声速，$\\omega=2\\pi f$ 是角频率。",
      ),
    );

    expect(html).toContain("katex");
    expect(html).not.toContain("$c(\\mathbf{r})$");
    expect(html).not.toContain("$\\omega=2\\pi f$");
  });

  it("rewrites assistant artifact images before Streamdown hardening", () => {
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(
          MessageResponse,
          {
            workspacePath: "/workspace",
            sessionId: "session-1",
            readAttachment: async () => ({
              bytes: new Uint8Array([1]),
              mediaType: "image/png",
            }),
          },
          "![CUA](zcode-artifact://session-1/shot)",
        ),
      ),
    );

    expect(html).toContain('data-markdown-local-image="loading"');
    expect(html).not.toContain("Image blocked");
    expect(html).not.toContain("zcode-artifact://");
  });

  it("keeps paired currency dollars as text", () => {
    const html = renderToStaticMarkup(
      createElement(
        MessageResponse,
        { workspacePath: "/workspace" },
        "Pricing is $5 today and $10 tomorrow.",
      ),
    );

    expect(html).not.toContain("katex");
    expect(html).toContain("Pricing is $5 today and $10 tomorrow.");
  });

  it("keeps compact currency ranges as text", () => {
    const html = renderToStaticMarkup(
      createElement(
        MessageResponse,
        { workspacePath: "/workspace" },
        "Pricing is $5-$10 depending on usage.",
      ),
    );

    expect(html).not.toContain("katex");
    expect(html).toContain("Pricing is $5-$10 depending on usage.");
  });

  it("keeps paired shell environment dollars as text", () => {
    const html = renderToStaticMarkup(
      createElement(
        MessageResponse,
        { workspacePath: "/workspace" },
        "Use $HOME and $PATH to inspect environment variables.",
      ),
    );

    expect(html).not.toContain("katex");
    expect(html).toContain("Use $HOME and $PATH to inspect environment variables.");
  });

  it("loads KaTeX CSS so MathML fallback does not duplicate visual output", () => {
    const styles = readFileSync(resolve(process.cwd(), "packages/ui/src/styles.css"), "utf8");
    const packageJson = JSON.parse(
      readFileSync(resolve(process.cwd(), "packages/ui/package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };

    expect(styles).toContain('@import "katex/dist/katex.min.css";');
    // Bugfix: styles.css 作为 @zcode/ui 的公开入口会被 web/desktop 直接构建，
    // 不能依赖 pnpm hoist 偶然把间接依赖 katex 放到根 node_modules。
    expect(packageJson.dependencies?.katex).toBeTruthy();
  });
});

it("通用模式回答保留代码容器和复制入口，锁定换行入口且模式变化会重新渲染", () => {
  const codePreviewSettings = {
    darkTheme: "github-dark",
    lightTheme: "github-light",
    fontSizePx: 13,
    wrapLongLines: false,
  };
  const props = { children: "```python\nprint('MODE_CODE_RETAINED')\n```", codePreviewSettings };
  const render = (forceCodeWrap: boolean) =>
    renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(
          TooltipProvider,
          null,
          createElement(MessageResponse, { ...props, forceCodeWrap }),
        ),
      ),
    );
  const general = render(true);
  expect(general).toContain('data-language="python"');
  expect(general).toContain("复制代码");
  expect(general).not.toContain("自动换行");
  expect(render(false)).toContain("自动换行");
  expect(codePreviewSettings.wrapLongLines).toBe(false);
  expect(
    messageResponsePropsAreEqual(
      { ...props, forceCodeWrap: true },
      { ...props, forceCodeWrap: false },
    ),
  ).toBe(false);
});
