import { describe, expect, it, vi } from "vitest";
import { shouldRenderAssistantPreviewCardAsFile } from "@/AssistantPreviewCards.js";
import {
  ASSISTANT_PREVIEW_CARD_CANDIDATE_LIMIT,
  ASSISTANT_PREVIEW_CARD_VISIBLE_LIMIT,
  buildAssistantPreviewCards,
  buildAssistantPreviewCardsFromReferences,
  extractAssistantFileReferences,
  shouldOpenAssistantHtmlInBrowser,
} from "@/lib/assistantPreviewCards.js";
import { resolveValidatedAssistantPreviewCards } from "@/lib/assistantPreviewCardValidation.js";

describe("assistant file extraction", () => {
  it("extracts the first-release audio and video formats", () => {
    const references = extractAssistantFileReferences(
      "Created clip.mp4, clip.mov, clip.webm, clip.m4v, song.mp3, song.wav, song.m4a, song.ogg, song.opus, song.flac and song.weba.",
      "/workspace",
    );

    expect(references.map(({ kind, path }) => ({ kind, path }))).toEqual([
      { kind: "video", path: "/workspace/clip.mp4" },
      { kind: "video", path: "/workspace/clip.mov" },
      { kind: "video", path: "/workspace/clip.webm" },
      { kind: "video", path: "/workspace/clip.m4v" },
      { kind: "audio", path: "/workspace/song.mp3" },
      { kind: "audio", path: "/workspace/song.wav" },
      { kind: "audio", path: "/workspace/song.m4a" },
      { kind: "audio", path: "/workspace/song.ogg" },
      { kind: "audio", path: "/workspace/song.opus" },
      { kind: "audio", path: "/workspace/song.flac" },
      { kind: "audio", path: "/workspace/song.weba" },
    ]);
  });

  it("正文和卡片共享可扩展的 Markdown、HTML、Office 与 PDF 文件抽取", () => {
    const references = extractAssistantFileReferences(
      "Created README.md, page.html, report.docx, data.xlsx, deck.pptx and paper.pdf.",
      "/workspace",
    );

    expect(references.map(({ kind, path }) => ({ kind, path }))).toEqual([
      { kind: "markdown", path: "/workspace/README.md" },
      { kind: "html", path: "/workspace/page.html" },
      { kind: "docx", path: "/workspace/report.docx" },
      { kind: "xlsx", path: "/workspace/data.xlsx" },
      { kind: "pptx", path: "/workspace/deck.pptx" },
      { kind: "pdf", path: "/workspace/paper.pdf" },
    ]);
  });

  it("citation 只向卡片抽取 DOCX、XLSX、PPTX 和 PDF，且不会重复抽取内部路径", async () => {
    const content = [
      '::zcode-file-citation{path="docs/项目 简介.docx" purpose="output" artifact_kind="document" page_number=2}',
      ':zcode-file-citation{path="sheets/年度 总结.xlsx" purpose="output"}',
      '::zcode-file-citation{path="slides/产品 路线.pptx" artifact_kind="presentation" slide_number=3}',
      '::zcode-file-citation{path="reports/审计 报告.pdf"}',
      ':::zcode-file-citation{path="reports/论文.pdf"}',
      '::zcode-file-citation{path="docs/说明.md"}',
      '::zcode-file-citation{path="reports/冲突.pdf" artifact_kind="document"}',
      '::zcode-file-citation{path="foo/../../private.pdf"}',
      '::zcode-file-citation{file="reports/伪装.pdf"}',
    ].join("\n");

    const references = extractAssistantFileReferences(content, "/workspace");

    expect(references.map(({ kind, path, raw }) => ({ kind, path, raw }))).toEqual([
      {
        kind: "docx",
        path: "/workspace/docs/项目 简介.docx",
        raw: "docs/项目 简介.docx",
      },
      {
        kind: "xlsx",
        path: "/workspace/sheets/年度 总结.xlsx",
        raw: "sheets/年度 总结.xlsx",
      },
      {
        kind: "pptx",
        path: "/workspace/slides/产品 路线.pptx",
        raw: "slides/产品 路线.pptx",
      },
      {
        kind: "pdf",
        path: "/workspace/reports/审计 报告.pdf",
        raw: "reports/审计 报告.pdf",
      },
      {
        kind: "pdf",
        path: "/workspace/reports/论文.pdf",
        raw: "reports/论文.pdf",
      },
    ]);

    const cards = buildAssistantPreviewCards(content, "/workspace");
    expect(cards.map(({ title }) => title)).toEqual([
      "论文.pdf",
      "审计 报告.pdf",
      "产品 路线.pptx",
      "年度 总结.xlsx",
      "项目 简介.docx",
    ]);

    const checkFilesExist = vi.fn(async ({ paths }: { paths: string[] }) =>
      paths.map((path) => ({ path, exists: true })),
    );
    await resolveValidatedAssistantPreviewCards(cards, { checkFilesExist });
    expect(checkFilesExist).toHaveBeenCalledWith({
      paths: [
        "/workspace/reports/论文.pdf",
        "/workspace/reports/审计 报告.pdf",
        "/workspace/slides/产品 路线.pptx",
        "/workspace/sheets/年度 总结.xlsx",
        "/workspace/docs/项目 简介.docx",
      ],
    });
  });

  it("citation 支持 video/audio artifact_kind 且要求后缀兼容", () => {
    const content = [
      '::zcode-file-citation{path="media/片段.mp4" artifact_kind="video"}',
      '::zcode-file-citation{path="media/声音.wav" artifact_kind="audio"}',
      '::zcode-file-citation{path="media/错误.mp3" artifact_kind="video"}',
    ].join("\n");

    expect(
      extractAssistantFileReferences(content, "/workspace").map(({ kind, path }) => ({
        kind,
        path,
      })),
    ).toEqual([
      { kind: "video", path: "/workspace/media/片段.mp4" },
      { kind: "audio", path: "/workspace/media/声音.wav" },
    ]);
  });

  it("支持智能引号 citation 和普通文件路径预览卡片", () => {
    const content = [
      "::zcode-file-citation{path=“reports/冰岛 行程.pdf” purpose=‘output’}",
      "普通输出 ‘docs/说明.md’ 和 “public/index.html”。",
      "Markdown 链接 [文档](<“docs/说明 文档.md”>)。",
    ].join("\n");

    expect(
      extractAssistantFileReferences(content, "/workspace").map(({ kind, path, raw }) => ({
        kind,
        path,
        raw,
      })),
    ).toEqual([
      {
        kind: "pdf",
        path: "/workspace/reports/冰岛 行程.pdf",
        raw: "reports/冰岛 行程.pdf",
      },
      {
        kind: "markdown",
        path: "/workspace/docs/说明.md",
        raw: "docs/说明.md",
      },
      {
        kind: "html",
        path: "/workspace/public/index.html",
        raw: "public/index.html",
      },
      {
        kind: "markdown",
        path: "/workspace/docs/说明 文档.md",
        raw: "docs/说明 文档.md",
      },
    ]);
  });

  it("普通路径错配引号时不回退为可预览文件", () => {
    for (const content of [
      '输出 ‘docs/report.pdf"。',
      "输出 ”docs/report.pdf”。",
      "输出 ’docs/report.pdf’。",
      "输出 “docs/report.pdf“。",
      "输出 “docs/report.pdf。",
      "输出 docs/report.pdf”。",
      "这是“重点.md。",
      '输出 ::zcode-file-citation{path=‘docs/report.pdf"}',
    ]) {
      expect(extractAssistantFileReferences(content, "/workspace")).toEqual([]);
    }
  });

  it("用同一规则抽取 Unicode、空格和 Windows 文件路径", () => {
    const references = extractAssistantFileReferences(
      [
        "生成了 **`dist/排队棋-Apagos.pptx`**。",
        "归档为 `资料 归档/年度 报告.pdf` 和 `年度 总结.xlsx`。",
        "Windows 路径是 C:\\Users\\张三\\演示 文稿.pptx。",
        "同时更新 docs/产品 说明.md 和 public/首页 index.html。",
      ].join("\n"),
      "/workspace",
    );

    expect(references.map(({ kind, path, raw }) => ({ kind, path, raw }))).toEqual([
      {
        kind: "pptx",
        path: "/workspace/dist/排队棋-Apagos.pptx",
        raw: "dist/排队棋-Apagos.pptx",
      },
      {
        kind: "pdf",
        path: "/workspace/资料 归档/年度 报告.pdf",
        raw: "资料 归档/年度 报告.pdf",
      },
      {
        kind: "xlsx",
        path: "/workspace/年度 总结.xlsx",
        raw: "年度 总结.xlsx",
      },
      {
        kind: "pptx",
        path: "C:/Users/张三/演示 文稿.pptx",
        raw: "C:\\Users\\张三\\演示 文稿.pptx",
      },
      {
        kind: "markdown",
        path: "/workspace/docs/产品 说明.md",
        raw: "docs/产品 说明.md",
      },
      {
        kind: "html",
        path: "/workspace/public/首页 index.html",
        raw: "public/首页 index.html",
      },
    ]);
  });

  it("使用当前 Host Home 展开 Home-relative Office 路径", () => {
    const references = extractAssistantFileReferences(
      "生成 `~/Desktop/GLM-5.3-Flash 模型能力介绍.pptx`。",
      "/workspace",
      { homePath: "/Users/demo" },
    );

    expect(references).toMatchObject([
      {
        kind: "pptx",
        path: "/Users/demo/Desktop/GLM-5.3-Flash 模型能力介绍.pptx",
        raw: "~/Desktop/GLM-5.3-Flash 模型能力介绍.pptx",
      },
    ]);
  });

  it("Home-relative PPTX 在 Host 存在性校验通过后展示卡片", async () => {
    const cards = buildAssistantPreviewCards(
      "生成 `~/Desktop/GLM-5.3-Flash 模型能力介绍.pptx`。",
      "/workspace",
      { homePath: "/Users/demo" },
    );
    const visibleCards = await resolveValidatedAssistantPreviewCards(cards, {
      checkFilesExist: async ({ paths }) => paths.map((path) => ({ path, exists: true })),
    });

    expect(visibleCards).toMatchObject([
      {
        kind: "pptx",
        path: "/Users/demo/Desktop/GLM-5.3-Flash 模型能力介绍.pptx",
      },
    ]);
  });

  it("Host Home 未就绪时不把 ~/ 路径错误拼入 workspace", () => {
    expect(extractAssistantFileReferences("生成 `~/Desktop/deck.pptx`。", "/workspace")).toEqual(
      [],
    );
  });

  it("相对路径越界时不生成卡片或存在性探测，安全回退路径先规范化", async () => {
    const content = ["foo/../../private.pdf", "./a/../report.pdf", "dir\\..\\..\\private.pdf"].join(
      " ",
    );

    expect(extractAssistantFileReferences(content, "/workspace")).toEqual([
      {
        kind: "pdf",
        path: "/workspace/report.pdf",
        raw: "./a/../report.pdf",
        start: 22,
        end: 39,
      },
    ]);

    const cards = buildAssistantPreviewCards(content, "/workspace");
    const checkFilesExist = vi.fn(async ({ paths }: { paths: string[] }) =>
      paths.map((path) => ({ path, exists: true })),
    );
    await resolveValidatedAssistantPreviewCards(cards, { checkFilesExist });

    expect(cards.map((card) => card.type === "file" && card.path)).toEqual([
      "/workspace/report.pdf",
    ]);
    expect(checkFilesExist).toHaveBeenCalledTimes(1);
    expect(checkFilesExist).toHaveBeenCalledWith({
      paths: ["/workspace/report.pdf"],
    });
  });

  it("Unicode 和空格 Markdown/HTML 仍使用本轮 fileChanges 门控", () => {
    const cards = buildAssistantPreviewCards(
      "生成 docs/产品 说明.md、public/首页 index.html 和 dist/排队棋-Apagos.pptx。",
      "/workspace",
      {
        changedFilePaths: ["/workspace/docs/产品 说明.md", "/workspace/public/首页 index.html"],
      },
    );

    expect(cards.map(({ title }) => title)).toEqual([
      "排队棋-Apagos.pptx",
      "首页 index.html",
      "产品 说明.md",
    ]);
  });

  it("卡片按正文出现位置逆序，Markdown/HTML 只保留本轮 active fileChanges", () => {
    const cards = buildAssistantPreviewCards(
      "README.md report.docx page.html deck.pptx data.xlsx paper.pdf missing.md old.html",
      "/workspace",
      {
        changedFilePaths: ["/workspace/README.md", "/workspace/page.html"],
      },
    );

    expect(cards.map((card) => card.title)).toEqual([
      "paper.pdf",
      "data.xlsx",
      "deck.pptx",
      "page.html",
      "report.docx",
      "README.md",
    ]);
  });

  it("Web 远控不展示本地 URL 和 HTML 卡片，但保留 Markdown、Office 与 PDF", () => {
    const cards = buildAssistantPreviewCards(
      [
        "预览 http://localhost:5173 和 http://127.0.0.1:4173。",
        "生成 README.md、index.html、report.docx、data.xlsx、deck.pptx 和 paper.pdf。",
      ].join(" "),
      "/workspace",
      {
        changedFilePaths: ["/workspace/README.md", "/workspace/index.html"],
        suppressWebRemoteCards: true,
      },
    );

    expect(cards.map(({ title }) => title)).toEqual([
      "paper.pdf",
      "deck.pptx",
      "data.xlsx",
      "report.docx",
      "README.md",
    ]);
    expect(cards.every((card) => card.type !== "website")).toBe(true);
  });

  it("预抽取引用可直接复用于构卡，不再重新扫描正文", () => {
    const cards = buildAssistantPreviewCardsFromReferences("文件已经生成。", "/workspace", [
      {
        kind: "pdf",
        path: "/workspace/年度 报告.pdf",
        raw: "年度 报告.pdf",
        start: 0,
        end: 9,
      },
    ]);

    expect(cards.map(({ title }) => title)).toEqual(["年度 报告.pdf"]);
  });

  it("只把逆序后的前 15 个候选交给存在性校验", () => {
    const content = Array.from({ length: 16 }, (_, index) => `file-${index + 1}.pdf`).join(" ");
    const cards = buildAssistantPreviewCards(content, "/workspace");

    expect(ASSISTANT_PREVIEW_CARD_CANDIDATE_LIMIT).toBe(15);
    expect(cards).toHaveLength(15);
    expect(cards[0]?.title).toBe("file-16.pdf");
    expect(cards.at(-1)?.title).toBe("file-2.pdf");
  });
});

describe("assistant preview validation", () => {
  it("单次批量校验并最多返回 10 个有效卡片", async () => {
    const cards = buildAssistantPreviewCards(
      Array.from({ length: 15 }, (_, index) => `file-${index + 1}.pdf`).join(" "),
      "/workspace",
    );
    const checkFilesExist = vi.fn(async ({ paths }: { paths: string[] }) =>
      paths.map((path) => ({ path, exists: true })),
    );

    const result = await resolveValidatedAssistantPreviewCards(cards, {
      checkFilesExist,
    });

    expect(ASSISTANT_PREVIEW_CARD_VISIBLE_LIMIT).toBe(10);
    expect(checkFilesExist).toHaveBeenCalledTimes(1);
    expect(checkFilesExist.mock.calls[0]?.[0].paths).toHaveLength(15);
    expect(result).toHaveLength(10);
    expect(result[0]?.title).toBe("file-15.pdf");
    expect(result.at(-1)?.title).toBe("file-6.pdf");
  });

  it("校验失败不从第 16 个候选回填", async () => {
    const cards = buildAssistantPreviewCards(
      Array.from({ length: 16 }, (_, index) => `file-${index + 1}.pdf`).join(" "),
      "/workspace",
    );
    const result = await resolveValidatedAssistantPreviewCards(cards, {
      checkFilesExist: async ({ paths }) =>
        paths.map((path, index) => ({ path, exists: index >= 6 })),
    });

    expect(result).toHaveLength(9);
    expect(result.some((card) => card.title === "file-1.pdf")).toBe(false);
  });
});

describe("assistant HTML open target", () => {
  it("本地桌面使用 Browser，远程 workspace 和手机远控降级为 Preview Pane", () => {
    expect(shouldOpenAssistantHtmlInBrowser({ path: "/workspace/page.html" })).toBe(true);
    expect(
      shouldOpenAssistantHtmlInBrowser({
        path: "/workspace/page.html",
        workspaceIdentity: "remote:ssh:host:/workspace",
        workspaceRemoteSessionId: "remote-1",
      }),
    ).toBe(false);
    expect(
      shouldOpenAssistantHtmlInBrowser({
        path: "/workspace/page.html",
        compactForRemoteControl: true,
      }),
    ).toBe(false);
  });

  it("远程只降级 file:// HTML，localhost HTTP 仍使用 Browser", () => {
    const remoteScope = {
      workspaceIdentity: "remote:ssh:host:/workspace",
      workspaceRemoteSessionId: "remote-1",
    };
    expect(
      shouldRenderAssistantPreviewCardAsFile(
        {
          id: "website:file:///workspace/page.html",
          type: "website",
          title: "page.html",
          subtitleId: "chat.previewCards.htmlWebsite",
          url: "file:///workspace/page.html",
          filePath: "/workspace/page.html",
        },
        remoteScope,
      ),
    ).toBe(true);
    expect(
      shouldRenderAssistantPreviewCardAsFile(
        {
          id: "website:http://localhost:5173/page.html",
          type: "website",
          title: "page.html",
          subtitleId: "chat.previewCards.website",
          url: "http://localhost:5173/page.html",
          filePath: "/workspace/page.html",
        },
        remoteScope,
      ),
    ).toBe(false);
  });
});
