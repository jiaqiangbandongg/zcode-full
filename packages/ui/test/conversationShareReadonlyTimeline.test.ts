import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import { ConversationShareReadonlyTimeline } from "@/v4/ConversationShareReadonlyTimeline.js";

// SG-01 注入边界：时间线不再静态 import OpenSplitButton（避免 open-with 子树进公开页 bundle），
// 改由消费方通过 artifactOpenAction 注入；测试用 stub 组件验证同一注入契约。
const openActionProps: { values: Array<Record<string, unknown>> } = { values: [] };

function StubArtifactOpenAction(props: Record<string, unknown>) {
  openActionProps.values.push(props);
  const target = props.target as
    | {
        path?: string;
        previewSource?: { workspacePath?: string };
      }
    | undefined;
  return createElement(
    "button",
    {
      type: "button",
      "data-open-split-button": "true",
      "data-target-path": target?.path ?? "",
      "data-preview-workspace": target?.previewSource?.workspacePath ?? "",
    },
    "Open",
  );
}

const rows = [
  {
    rowId: 1,
    turnId: "turn-1",
    productTurnId: "product-turn-1",
    createdAt: 1,
    createdAtSeq: 1,
    kind: "turnHeader" as const,
    origin: "userInput" as const,
    state: "completedSuccess" as const,
    startedAt: 1,
  },
  {
    rowId: 2,
    turnId: "turn-1",
    productTurnId: "product-turn-1",
    createdAt: 2,
    createdAtSeq: 2,
    kind: "userInput" as const,
    origin: "realUser" as const,
    text: "请总结今天的新闻",
  },
  {
    rowId: 3,
    turnId: "turn-1",
    productTurnId: "product-turn-1",
    createdAt: 3,
    createdAtSeq: 3,
    kind: "assistantText" as const,
    text: "这是 **摘要**",
    state: "complete" as const,
  },
  {
    rowId: 4,
    turnId: "turn-1",
    productTurnId: "product-turn-1",
    createdAt: 4,
    createdAtSeq: 4,
    kind: "toolCall" as const,
    toolCallId: "tool-1",
    toolName: "WebSearch",
    status: "success" as const,
    inputText: "query",
    output: { text: "result" },
  },
];

const buildArtifactRow = (rowId: number, artifactVersionId: string) => ({
  rowId,
  turnId: "turn-1",
  productTurnId: "product-turn-1",
  createdAt: rowId,
  createdAtSeq: rowId,
  kind: "artifact" as const,
  artifactVersionId,
  logicalArtifactKey: "report",
  displayName: "晨报.pdf",
  artifactType: "pdf" as const,
  mimeType: "application/pdf",
  sizeBytes: 172_974,
  sha256: "a".repeat(64),
  ref: `zcode-artifact://share/${artifactVersionId}`,
  state: "current" as const,
});

describe("ConversationShareReadonlyTimeline", () => {
  beforeEach(() => {
    openActionProps.values = [];
  });

  it("uses Desktop user bubble, assistant markdown, turn grouping, and tool summary", () => {
    const html = renderToStaticMarkup(
      createElement(ConversationShareReadonlyTimeline, {
        rows,
        locale: "zh-CN",
      }),
    );
    expect(html).toContain('data-v4-user-input-bubble="true"');
    expect(html).toContain("rounded-tr-xs");
    expect(html).toContain("这是");
    expect(html).toContain('data-conversation-share-turn="turn-1"');
    expect(html).toContain("搜索");
    expect(html).toContain("tool-summary");
    expect(html).not.toContain("<details");
    expect(html).not.toContain("canEdit");
    expect(html).not.toContain("turn · userInput · completedSuccess");
  });

  it("renders shared user input attachments as downloadable file pills", () => {
    const attachmentRows = [
      rows[0],
      {
        ...rows[1],
        attachments: [
          {
            ref: "zcode-artifact://share/share-input-text-1",
            previewRef: "zcode-artifact://share/share-input-text-1",
            fileName: "pasted-text.txt",
            mime: "text/plain",
            bytes: 245_760,
          },
        ],
      },
      rows[2],
    ];
    const html = renderToStaticMarkup(
      createElement(ConversationShareReadonlyTimeline, {
        rows: attachmentRows,
        artifactUrls: new Map([
          ["share-input-text-1", "https://share.example.test/artifacts/text-1"],
        ]),
        locale: "en-US",
      }),
    );
    expect(html).toContain("pasted-text.txt");
    expect(html).toContain("https://share.example.test/artifacts/text-1");
    expect(html).toContain('data-v4-user-input-attachment-pill="true"');
  });

  it("keeps the user prompt before the history status and formats work duration like Desktop", () => {
    const historyRows = [
      {
        ...rows[0],
        activeMs: 165_000,
      },
      rows[1],
      {
        rowId: 7,
        turnId: "turn-1",
        productTurnId: "product-turn-1",
        createdAt: 7,
        createdAtSeq: 7,
        kind: "reasoning" as const,
        text: "先整理数据，再输出结论。",
        state: "complete" as const,
        durationMs: 2_000,
      },
      rows[2],
    ];
    const html = renderToStaticMarkup(
      createElement(ConversationShareReadonlyTimeline, {
        rows: historyRows,
        locale: "zh-CN",
      }),
    );
    expect(html.indexOf('data-v4-user-input-bubble="true"')).toBeLessThan(
      html.indexOf('data-conversation-share-history-trigger="true"'),
    );
    expect(html).toContain("已工作 2 分 45 秒");
  });

  it("renders headings and tables through the Desktop MessageResponse pipeline", () => {
    const markdownRows = [
      rows[0],
      rows[1],
      {
        ...rows[2],
        text: [
          "普通段落",
          "",
          "---",
          "",
          "# 标题",
          "",
          "## 二级标题",
          "",
          "| 项目 | 内容 |",
          "| --- | --- |",
          "| 公司 | **ZCode** |",
          "",
          "```ts",
          "const answer = 42;",
          "```",
        ].join("\n"),
      },
    ];
    const html = renderToStaticMarkup(
      createElement(ConversationShareReadonlyTimeline, {
        rows: markdownRows,
        locale: "zh-CN",
      }),
    );
    expect(html).toContain('data-streamdown="heading-1"');
    expect(html).toContain('data-streamdown="heading-2"');
    expect(html).toContain("<table");
    expect(html).toContain("data-markdown-table-toolbar");
    expect(html).not.toContain("# 标题");
    expect(html).not.toContain("| 项目 | 内容 |");
  });

  it("uses Desktop execute grouping for consecutive shell tool rows", () => {
    const executeRows = [
      rows[0],
      rows[1],
      rows[2],
      {
        rowId: 5,
        turnId: "turn-1",
        productTurnId: "product-turn-1",
        createdAt: 5,
        createdAtSeq: 5,
        kind: "toolCall" as const,
        toolCallId: "execute-1",
        toolName: "Bash",
        status: "success" as const,
        inputText: "echo one",
        input: { command: "echo one" },
        output: { text: "one" },
      },
      {
        rowId: 6,
        turnId: "turn-1",
        productTurnId: "product-turn-1",
        createdAt: 6,
        createdAtSeq: 6,
        kind: "toolCall" as const,
        toolCallId: "execute-2",
        toolName: "Bash",
        status: "success" as const,
        inputText: "echo two",
        input: { command: "echo two" },
        output: { text: "two" },
      },
    ];

    const html = renderToStaticMarkup(
      createElement(ConversationShareReadonlyTimeline, {
        rows: executeRows,
        locale: "zh-CN",
      }),
    );

    expect(html).toContain('data-conversation-share-work-group="executeGroup"');
    expect(html).toContain("执行");
    expect(html).toContain("lucide-square-terminal");
  });

  it("uses the Desktop tool family icon and public summary for search rows", () => {
    const searchRows = [
      rows[0],
      rows[1],
      rows[2],
      {
        ...rows[3],
        input: { query: "AI coding" },
      },
    ];
    const html = renderToStaticMarkup(
      createElement(ConversationShareReadonlyTimeline, {
        rows: searchRows,
        locale: "zh-CN",
      }),
    );

    expect(html).toContain("lucide-search");
    expect(html).toContain("AI coding");
    expect(html).not.toContain("lucide-wrench");
  });

  it("marker 不再把枚举名当文案印出来", () => {
    // Bug 根因：原本直接渲染 row.marker.type，分享页会出现一条写着字面量 compact 的分割线。
    const markerRows = [
      rows[0],
      rows[1],
      {
        rowId: 90,
        turnId: "turn-1",
        productTurnId: "product-turn-1",
        createdAt: 90,
        createdAtSeq: 90,
        kind: "timelineMarker" as const,
        lane: "turnTailBoundary" as const,
        marker: { type: "compact" as const, origin: "auto" as const, status: "success" as const },
      },
      {
        rowId: 91,
        turnId: "turn-1",
        productTurnId: "product-turn-1",
        createdAt: 91,
        createdAtSeq: 91,
        kind: "timelineMarker" as const,
        lane: "turnTailBoundary" as const,
        marker: { type: "goalVerify" as const, iteration: 1, outcome: "pass" as const },
      },
    ];
    const html = renderToStaticMarkup(
      createElement(ConversationShareReadonlyTimeline, {
        rows: markerRows as never,
        locale: "zh-CN",
      }),
    );

    expect(html).toContain("上下文已压缩");
    expect(html).not.toContain(">compact<");
    // 识别不了的类型整行不渲染，而不是退化成打印枚举名。
    expect(html).not.toContain("goalVerify");
  });

  it("artifact 卡片与正文的 AssistantPreviewCards 对齐", () => {
    const artifactRows = [
      rows[0],
      rows[1],
      {
        rowId: 80,
        turnId: "turn-1",
        productTurnId: "product-turn-1",
        createdAt: 80,
        createdAtSeq: 80,
        kind: "artifact" as const,
        artifactVersionId: "artifact-1",
        logicalArtifactKey: "report",
        displayName: "晨报.pdf",
        artifactType: "pdf" as const,
        mimeType: "application/pdf",
        sizeBytes: 172_974,
        sha256: "a".repeat(64),
        ref: "zcode-artifact://share/artifact-1",
        state: "current" as const,
      },
    ];
    const html = renderToStaticMarkup(
      createElement(ConversationShareReadonlyTimeline, {
        rows: artifactRows as never,
        locale: "zh-CN",
        artifactUrls: new Map([["artifact-1", "https://example.invalid/a.pdf"]]),
      }),
    );

    // 与 AssistantPreviewCards.tsx 的容器一致：rounded-xl / p-3 pr-4 / gap-3。
    expect(html).toContain(
      "flex w-full items-center gap-3 rounded-xl border border-card-border bg-card p-3 pr-4",
    );
    // 时间线 turn 已提供正文 inset，artifact 行不能再叠加水平 padding，否则卡片会比正文窄。
    expect(html).toContain('data-conversation-share-row-kind="artifact" class="py-1"');
    // 44px 图标底板 + 真实文件类型图标，而不是一个通用的 size-4 FileIcon。
    expect(html).toContain("flex size-11 shrink-0 items-center justify-center rounded-md");
    expect(html).toContain("pdf.svg");
    // 副标题复用正文同一套词汇，并且不再直接印裸字节数。
    expect(html).toContain("文档 · PDF");
    expect(html).toContain("169 KB");
    expect(html).not.toContain("172974 bytes");
    // 动作按钮与 OpenSplitButton 同一视觉，不再是蓝色文字链；语义锁定用结构性标记，
    // 不锁 Tailwind 类字符串（类序/尺寸微调不应打断这条回归）。
    expect(html).toContain('data-share-preview-button="true"');
    expect(html).not.toContain("text-icon-blue");
  });

  it("为 Desktop 导入副本的本地 artifact 渲染 OpenSplitButton", () => {
    const artifactRows = [
      rows[0],
      rows[1],
      {
        rowId: 80,
        turnId: "turn-1",
        productTurnId: "product-turn-1",
        createdAt: 80,
        createdAtSeq: 80,
        kind: "artifact" as const,
        artifactVersionId: "artifact-1",
        logicalArtifactKey: "report",
        displayName: "晨报.pdf",
        artifactType: "pdf" as const,
        mimeType: "application/pdf",
        sizeBytes: 172_974,
        sha256: "a".repeat(64),
        ref: "zcode-artifact://share/artifact-1",
        state: "current" as const,
      },
    ];
    const html = renderToStaticMarkup(
      createElement(ConversationShareReadonlyTimeline, {
        rows: artifactRows as never,
        locale: "zh-CN",
        workspacePath: "/workspace",
        artifactWorkspaceRelativePaths: new Map([
          ["artifact-1", ".zcode-share/share-1/shared-artifacts/晨报.pdf"],
        ]),
        onOpenCodeViewer: () => undefined,
        artifactOpenAction: StubArtifactOpenAction,
      }),
    );

    expect(html).toContain('data-open-split-button="true"');
    expect(html).toContain(
      'data-target-path="/workspace/.zcode-share/share-1/shared-artifacts/晨报.pdf"',
    );
    expect(openActionProps.values).toHaveLength(1);
    expect(openActionProps.values[0]?.target).toMatchObject({
      type: "file",
      path: "/workspace/.zcode-share/share-1/shared-artifacts/晨报.pdf",
      title: "晨报.pdf",
      label: "晨报.pdf",
      previewSource: {
        type: "file",
        title: "晨报.pdf",
        path: "/workspace/.zcode-share/share-1/shared-artifacts/晨报.pdf",
        workspacePath: "/workspace",
      },
    });
  });

  it("不注入 artifactOpenAction 时本地 artifact 不渲染任何打开控件", () => {
    // 与静态守卫（conversationShareBundleBoundary.test.ts）互补的运行时负例：公开页
    // （packages/web/src/share）不传 artifactOpenAction。锁住 ArtifactOpenContext 门控里的
    // !artifactOpenAction 条件——即使 workspacePath、合法相对路径、打开回调齐备，也必须
    // 退回纯只读卡片，防止后续加默认回退实现让公开页重新获得本地打开入口。
    const artifactRows = [rows[0], rows[1], buildArtifactRow(80, "artifact-1")];
    const html = renderToStaticMarkup(
      createElement(ConversationShareReadonlyTimeline, {
        rows: artifactRows as never,
        locale: "zh-CN",
        workspacePath: "/workspace",
        artifactWorkspaceRelativePaths: new Map([
          ["artifact-1", ".zcode-share/share-1/shared-artifacts/晨报.pdf"],
        ]),
        onOpenCodeViewer: () => undefined,
      }),
    );

    expect(html).toContain("晨报.pdf");
    expect(html).not.toContain('data-open-split-button="true"');
    expect(html).not.toContain('data-share-preview-button="true"');
    expect(openActionProps.values).toHaveLength(0);
  });

  it("拒绝导入副本里越界的 artifact path", () => {
    const artifactRows = [
      rows[0],
      rows[1],
      {
        rowId: 80,
        turnId: "turn-1",
        productTurnId: "product-turn-1",
        createdAt: 80,
        createdAtSeq: 80,
        kind: "artifact" as const,
        artifactVersionId: "artifact-1",
        logicalArtifactKey: "report",
        displayName: "晨报.pdf",
        artifactType: "pdf" as const,
        mimeType: "application/pdf",
        sizeBytes: 172_974,
        sha256: "a".repeat(64),
        ref: "zcode-artifact://share/artifact-1",
        state: "current" as const,
      },
    ];
    const html = renderToStaticMarkup(
      createElement(ConversationShareReadonlyTimeline, {
        rows: artifactRows as never,
        locale: "zh-CN",
        workspacePath: "/workspace",
        artifactWorkspaceRelativePaths: new Map([["artifact-1", "../secret.pdf"]]),
        onOpenCodeViewer: () => undefined,
        artifactOpenAction: StubArtifactOpenAction,
      }),
    );

    expect(html).toContain("晨报.pdf");
    expect(html).not.toContain('data-open-split-button="true"');
    expect(openActionProps.values).toHaveLength(0);
  });

  it("拒绝导入副本里的绝对路径 artifact path", () => {
    // 公开页隐私边界：posix / Windows 盘符 / UNC 三种绝对路径形态都必须退回纯只读卡片。
    const artifactRows = [
      rows[0],
      rows[1],
      buildArtifactRow(80, "artifact-1"),
      buildArtifactRow(81, "artifact-2"),
      buildArtifactRow(82, "artifact-3"),
    ];
    const html = renderToStaticMarkup(
      createElement(ConversationShareReadonlyTimeline, {
        rows: artifactRows as never,
        locale: "zh-CN",
        workspacePath: "/workspace",
        artifactWorkspaceRelativePaths: new Map([
          ["artifact-1", "/etc/passwd"],
          ["artifact-2", "C:\\x\\a.pdf"],
          ["artifact-3", "\\\\srv\\share\\a.pdf"],
        ]),
        onOpenCodeViewer: () => undefined,
        artifactOpenAction: StubArtifactOpenAction,
      }),
    );

    expect(html).toContain("晨报.pdf");
    expect(html).not.toContain('data-open-split-button="true"');
    expect(openActionProps.values).toHaveLength(0);
  });

  it("拒绝导入副本里段数不为 4 或含 ./.. 段的 artifact path", () => {
    // "../secret.pdf" 在段数校验就被拒了，这里专门补 4 段但段内含 .. 的逃逸形态。
    const artifactRows = [
      rows[0],
      rows[1],
      buildArtifactRow(80, "artifact-1"),
      buildArtifactRow(81, "artifact-2"),
      buildArtifactRow(82, "artifact-3"),
      buildArtifactRow(83, "artifact-4"),
      buildArtifactRow(84, "artifact-5"),
    ];
    const html = renderToStaticMarkup(
      createElement(ConversationShareReadonlyTimeline, {
        rows: artifactRows as never,
        locale: "zh-CN",
        workspacePath: "/workspace",
        artifactWorkspaceRelativePaths: new Map([
          // 嵌套子目录：5 段。
          ["artifact-1", ".zcode-share/share-1/shared-artifacts/sub/a.pdf"],
          // 浅路径：3 段。
          ["artifact-2", ".zcode-share/share-1/a.pdf"],
          // 4 段但第 2 段是 ..：等价于跳出本 share 目录。
          ["artifact-3", ".zcode-share/../shared-artifacts/a.pdf"],
          // 4 段但文件名是 .：不是合法产物文件。
          ["artifact-4", ".zcode-share/share-1/shared-artifacts/."],
          // 反斜杠分隔不能绕过段校验。
          ["artifact-5", ".zcode-share\\share-1\\shared-artifacts\\a.pdf\\..\\b.pdf"],
        ]),
        onOpenCodeViewer: () => undefined,
        artifactOpenAction: StubArtifactOpenAction,
      }),
    );

    expect(html).toContain("晨报.pdf");
    expect(html).not.toContain('data-open-split-button="true"');
    expect(openActionProps.values).toHaveLength(0);
  });

  it.each([
    ["zh-CN", "下载文件"],
    ["en-US", "Download file"],
  ])("artifactUrls 与本地路径同时存在时 url 必须胜出（%s）", (locale, label) => {
    // 公开页隐私边界的关键前提：ArtifactPresentation 只在 !url 时解析本地路径；
    // url 存在时必须渲染 window.open 按钮，而不是能触达本地文件服务的 OpenSplitButton。
    const artifactRows = [rows[0], rows[1], buildArtifactRow(80, "artifact-1")];
    const html = renderToStaticMarkup(
      createElement(ConversationShareReadonlyTimeline, {
        rows: artifactRows as never,
        locale,
        workspacePath: "/workspace",
        artifactUrls: new Map([["artifact-1", "https://example.invalid/a.pdf"]]),
        artifactWorkspaceRelativePaths: new Map([
          ["artifact-1", ".zcode-share/share-1/shared-artifacts/晨报.pdf"],
        ]),
        onOpenCodeViewer: () => undefined,
        artifactOpenAction: StubArtifactOpenAction,
      }),
    );

    // 资源 URL 实际下载文件，按钮文案必须对应下载，且注入的本地打开动作完全未挂载。
    expect(html).toContain(label);
    expect(html).not.toContain("预览文件");
    expect(html).not.toContain("Preview file");
    expect(html).toContain('data-share-preview-button="true"');
    expect(html).not.toContain('data-open-split-button="true"');
    expect(openActionProps.values).toHaveLength(0);
  });

  // Bug 回归：公开分享页不传 workspacePath/readAttachment，MarkdownImage 会 fallback 成
  // <img src={远程}>，匿名访客一打开就自动向第三方发请求（泄露 IP/UA/Referer）。
  // 正文与工具输出都必须只剩链接，不能出现自动加载的 <img>。
  it("不为正文与工具输出里的远程图片渲染自动加载的 img", () => {
    const remoteImageRows = [
      {
        rowId: 1,
        turnId: "turn-1",
        productTurnId: "product-turn-1",
        createdAt: 1,
        createdAtSeq: 1,
        kind: "turnHeader" as const,
        origin: "userInput" as const,
        state: "completedSuccess" as const,
        startedAt: 1,
      },
      {
        rowId: 2,
        turnId: "turn-1",
        productTurnId: "product-turn-1",
        createdAt: 2,
        createdAtSeq: 2,
        kind: "assistantText" as const,
        text: "看图 ![tracker](https://tracker.invalid/pixel.png)",
        state: "complete" as const,
      },
      {
        rowId: 3,
        turnId: "turn-1",
        productTurnId: "product-turn-1",
        createdAt: 3,
        createdAtSeq: 3,
        kind: "toolCall" as const,
        toolCallId: "tool-1",
        toolName: "WebSearch",
        status: "success" as const,
        inputText: "query",
        output: { text: "结果 ![tracker](https://tracker.invalid/tool.png)" },
      },
    ];

    const html = renderToStaticMarkup(
      createElement(ConversationShareReadonlyTimeline, {
        rows: remoteImageRows as never,
        locale: "zh-CN",
      }),
    );

    // 关键不是 URL 是否出现在 HTML 里（链接的 title 属性带着它无害），
    // 而是不能有任何自动发起请求的 <img src>。
    expect(html).not.toContain("<img");
    expect(html).not.toContain('src="https://tracker.invalid');
    // 信息不丢：降级成外链后 URL 仍可被访客显式点击。
    expect(html).toContain('title="https://tracker.invalid/pixel.png"');
    expect(html).toContain("tracker");
  });
});
