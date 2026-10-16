import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildAssistantPreviewCardFileSource,
  buildAssistantPreviewPptxAutoOpenRequest,
} from "@/AssistantPreviewCards.js";
import {
  buildAssistantPreviewCards,
  requiresAssistantPreviewCardFileStat,
  type AssistantPreviewCard,
} from "@/lib/assistantPreviewCards.js";
import {
  resolveAssistantPreviewCardsWithoutFileStat,
  resolveValidatedAssistantPreviewCards,
} from "@/lib/assistantPreviewCardValidation.js";

const assistantPreviewCardsSource = readFileSync(
  new URL("../src/AssistantPreviewCards.tsx", import.meta.url),
  "utf8",
);

describe("AssistantPreviewCards presentation", () => {
  it("统一使用 24px 的网址、文件和兜底图标", () => {
    expect(assistantPreviewCardsSource).toContain('<GlobeIcon className="size-6" />');
    expect(assistantPreviewCardsSource).toContain(
      "<FileDisplayIcon src={descriptor.fileIconSrc} size={24} />",
    );
    expect(assistantPreviewCardsSource).toContain('<FileTextIcon className="size-6" />');
  });
});

describe("assistant PPTX auto-open projection", () => {
  it("只投影最终可见卡片中的 PPTX，并把卡片签名并入一次性 key", () => {
    const cards = [
      {
        id: "file:pdf:/workspace/report.pdf",
        type: "file" as const,
        kind: "pdf" as const,
        title: "report.pdf",
        subtitleId: "chat.previewCards.pdf" as const,
        path: "/workspace/report.pdf",
      },
      {
        id: "file:pptx:/workspace/first.pptx",
        type: "file" as const,
        kind: "pptx" as const,
        title: "first.pptx",
        subtitleId: "chat.previewCards.pptx" as const,
        path: "/workspace/first.pptx",
      },
      {
        id: "file:pptx:/workspace/second.pptx",
        type: "file" as const,
        kind: "pptx" as const,
        title: "second.pptx",
        subtitleId: "chat.previewCards.pptx" as const,
        path: "/workspace/second.pptx",
      },
    ];

    const request = buildAssistantPreviewPptxAutoOpenRequest(cards, "turn-key", {
      workspacePath: "/workspace",
      workspaceIdentity: "remote:ssh:host:/workspace",
      workspaceRemoteSessionId: "remote-1",
    });

    expect(request?.sources).toEqual([
      expect.objectContaining({ path: "/workspace/first.pptx" }),
      expect.objectContaining({ path: "/workspace/second.pptx" }),
    ]);
    expect(request?.key).toContain("turn-key");
    expect(request?.key).toContain("first.pptx");
    expect(request?.key).toContain("second.pptx");
    expect(request?.key).not.toContain("report.pdf");
  });
});

describe("buildAssistantPreviewCards", () => {
  it("为远程 Markdown 卡片构建完整 workspace scope", () => {
    expect(
      buildAssistantPreviewCardFileSource(
        {
          id: "markdown:/workspace/README.md",
          type: "markdown",
          kind: "markdown",
          title: "README.md",
          path: "/workspace/README.md",
          subtitleId: "chat.previewCards.markdown",
        },
        {
          workspacePath: "/workspace",
          workspaceIdentity: "remote:ssh:host-a:/workspace",
          workspaceRemoteSessionId: "session-a",
        },
      ),
    ).toEqual({
      type: "file",
      title: "README.md",
      path: "/workspace/README.md",
      workspacePath: "/workspace",
      workspaceIdentity: "remote:ssh:host-a:/workspace",
      workspaceRemoteSessionId: "session-a",
    });
  });

  it("builds website cards for localhost links with markdown labels", () => {
    const cards = buildAssistantPreviewCards(
      "Open [Neon Snake](http://localhost:5173/play) when ready.",
      "/workspace",
    );

    expect(cards).toEqual([
      {
        id: "website:http://localhost:5173/play",
        type: "website",
        title: "Neon Snake",
        subtitleId: "chat.previewCards.website",
        url: "http://localhost:5173/play",
      },
    ]);
  });

  it("builds website cards for 127.0.0.1 links", () => {
    const cards = buildAssistantPreviewCards("Preview: http://127.0.0.1:3000.", "/workspace");

    expect(cards).toMatchObject([
      {
        type: "website",
        title: "127.0.0.1:3000",
        url: "http://127.0.0.1:3000",
      },
    ]);
  });

  it("builds markdown cards from links and raw paths without duplicates", () => {
    const cards = buildAssistantPreviewCards(
      [
        "Updated [summary](./docs/ui/task-file-change-summary.md).",
        "Also see docs/ui/task-file-change-summary.md and CHANGELOG.md.",
      ].join("\n"),
      "/workspace",
      {
        changedFilePaths: [
          "/workspace/docs/ui/task-file-change-summary.md",
          "/workspace/CHANGELOG.md",
        ],
      },
    );

    expect(cards).toMatchObject([
      {
        type: "markdown",
        title: "CHANGELOG.md",
        path: "/workspace/CHANGELOG.md",
      },
      {
        type: "markdown",
        title: "task-file-change-summary.md",
        path: "/workspace/docs/ui/task-file-change-summary.md",
      },
    ]);
  });

  it("builds html website cards from generated html file paths", () => {
    const cards = buildAssistantPreviewCards(
      "Generated index.html and ./public/demo.htm.",
      "/workspace",
      {
        changedFilePaths: ["/workspace/index.html", "/workspace/public/demo.htm"],
      },
    );

    expect(cards).toMatchObject([
      {
        type: "website",
        title: "demo.htm",
        subtitleId: "chat.previewCards.htmlWebsite",
        url: "file:///workspace/public/demo.htm",
      },
      {
        type: "website",
        title: "index.html",
        subtitleId: "chat.previewCards.htmlWebsite",
        url: "file:///workspace/index.html",
      },
    ]);
  });

  it("builds html website cards from file URLs", () => {
    const cards = buildAssistantPreviewCards(
      "Preview file:///workspace/demo.html when ready.",
      "/workspace",
      { changedFilePaths: ["/workspace/demo.html"] },
    );

    expect(cards).toMatchObject([
      {
        type: "website",
        title: "demo.html",
        subtitleId: "chat.previewCards.htmlWebsite",
        url: "file:///workspace/demo.html",
      },
    ]);
  });

  it("resolves bare html names from changed file paths first", () => {
    const cards = buildAssistantPreviewCards("Generated index.html.", "/workspace", {
      changedFilePaths: ["/workspace/game/index.html"],
    });

    expect(cards).toMatchObject([
      {
        type: "website",
        title: "index.html",
        subtitleId: "chat.previewCards.htmlWebsite",
        url: "file:///workspace/game/index.html",
      },
    ]);
    expect(cards).toHaveLength(1);
  });

  it("does not build html file cards when a local http preview exists", () => {
    const cards = buildAssistantPreviewCards(
      [
        "Preview http://localhost:5173.",
        "Generated index.html and file:///workspace/public/demo.html.",
        "See [notes](./docs/notes.md).",
      ].join("\n"),
      "/workspace",
      {
        changedFilePaths: ["/workspace/game/index.html", "/workspace/docs/notes.md"],
      },
    );

    expect(cards).toMatchObject([
      {
        type: "markdown",
        path: "/workspace/docs/notes.md",
      },
      {
        type: "website",
        url: "http://localhost:5173",
      },
    ]);
    expect(cards).toHaveLength(2);
  });

  it("filters invalid website candidates after regex extraction", () => {
    expect(buildAssistantPreviewCards("Preview http://localhost:70000.", "/workspace")).toEqual([]);
    expect(
      buildAssistantPreviewCards(
        "Preview file://demo.html and file:///workspace/demo.html.",
        "/workspace",
        { changedFilePaths: ["/workspace/demo.html"] },
      ),
    ).toMatchObject([
      {
        type: "website",
        url: "file:///workspace/demo.html",
      },
    ]);
  });

  it("trims markdown emphasis and CJK punctuation from localhost URLs", () => {
    const cards = buildAssistantPreviewCards(
      "服务地址是 **http://localhost:8765/dashboard/index.html**，你现在可以在浏览器打开试试。",
      "/workspace",
      {
        changedFilePaths: ["/workspace/dashboard/index.html"],
      },
    );

    expect(cards).toEqual([
      {
        id: "website:http://localhost:8765/dashboard/index.html",
        type: "website",
        title: "index.html",
        subtitleId: "chat.previewCards.website",
        url: "http://localhost:8765/dashboard/index.html",
        filePath: "/workspace/dashboard/index.html",
      },
    ]);
    expect(cards.map((card) => requiresAssistantPreviewCardFileStat(card))).toEqual([true]);
  });

  it("treats localhost html URL paths as workspace files before rendering", () => {
    const cards = buildAssistantPreviewCards(
      "服务地址是 http://localhost:8765/dashboard/index.html。",
      "/workspace",
      { changedFilePaths: ["/workspace/dashboard/index.html"] },
    );

    expect(cards).toEqual([
      {
        id: "website:http://localhost:8765/dashboard/index.html",
        type: "website",
        title: "index.html",
        subtitleId: "chat.previewCards.website",
        url: "http://localhost:8765/dashboard/index.html",
        filePath: "/workspace/dashboard/index.html",
      },
    ]);
    expect(cards.map((card) => requiresAssistantPreviewCardFileStat(card))).toEqual([true]);
  });

  it("deduplicates localhost cards and ignores polluted markdown link labels", () => {
    const cards = buildAssistantPreviewCards(
      [
        "[** (kernel](http://127.0.0.1:8781)",
        "[) 。完整](http://127.0.0.1:8781)",
        "也可以直接打开 http://127.0.0.1:8781。",
      ].join("\n"),
      "/workspace",
    );

    expect(cards).toEqual([
      {
        id: "website:http://127.0.0.1:8781",
        type: "website",
        title: "127.0.0.1:8781",
        subtitleId: "chat.previewCards.website",
        url: "http://127.0.0.1:8781",
      },
    ]);
  });

  it("classifies cards that require file stat", () => {
    const cards: AssistantPreviewCard[] = [
      {
        id: "website:http://localhost:5173",
        type: "website",
        title: "localhost:5173",
        subtitleId: "chat.previewCards.website",
        url: "http://localhost:5173",
      },
      {
        id: "website:http://localhost:70000",
        type: "website",
        title: "localhost:70000",
        subtitleId: "chat.previewCards.website",
        url: "http://localhost:70000",
      },
      {
        id: "website:http://localhost:8765/dashboard/index.html",
        type: "website",
        title: "index.html",
        subtitleId: "chat.previewCards.website",
        url: "http://localhost:8765/dashboard/index.html",
        filePath: "/workspace/dashboard/index.html",
      },
      {
        id: "website:file:///workspace/index.html",
        type: "website",
        title: "index.html",
        subtitleId: "chat.previewCards.htmlWebsite",
        url: "file:///workspace/index.html",
      },
      {
        id: "website:file:///workspace/missing.html",
        type: "website",
        title: "missing.html",
        subtitleId: "chat.previewCards.htmlWebsite",
        url: "file:///workspace/missing.html",
      },
      {
        id: "markdown:/workspace/exists.md",
        type: "markdown",
        kind: "markdown",
        title: "exists.md",
        subtitleId: "chat.previewCards.markdown",
        path: "/workspace/exists.md",
      },
      {
        id: "markdown:/workspace/dir.md",
        type: "markdown",
        kind: "markdown",
        title: "dir.md",
        subtitleId: "chat.previewCards.markdown",
        path: "/workspace/dir.md",
      },
      {
        id: "markdown:/workspace/missing.md",
        type: "markdown",
        kind: "markdown",
        title: "missing.md",
        subtitleId: "chat.previewCards.markdown",
        path: "/workspace/missing.md",
      },
    ];
    expect(cards.map((card) => requiresAssistantPreviewCardFileStat(card))).toEqual([
      false,
      false,
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
  });

  it("returns stat-free preview cards synchronously", () => {
    const cards: AssistantPreviewCard[] = [
      {
        id: "website:http://localhost:5173",
        type: "website",
        title: "localhost:5173",
        subtitleId: "chat.previewCards.website",
        url: "http://localhost:5173",
      },
      {
        id: "website:http://localhost:70000",
        type: "website",
        title: "bad localhost",
        subtitleId: "chat.previewCards.website",
        url: "http://localhost:70000",
      },
    ];

    expect(resolveAssistantPreviewCardsWithoutFileStat(cards)).toEqual([cards[0]]);
  });

  it("waits for all file-backed preview checks before returning renderable cards", async () => {
    const cards: AssistantPreviewCard[] = [
      {
        id: "markdown:/workspace/README.md",
        type: "markdown",
        kind: "markdown",
        title: "README.md",
        subtitleId: "chat.previewCards.markdown",
        path: "/workspace/README.md",
      },
      {
        id: "markdown:/workspace/missing.md",
        type: "markdown",
        kind: "markdown",
        title: "missing.md",
        subtitleId: "chat.previewCards.markdown",
        path: "/workspace/missing.md",
      },
      {
        id: "website:file:///workspace/index.html",
        type: "website",
        title: "index.html",
        subtitleId: "chat.previewCards.htmlWebsite",
        url: "file:///workspace/index.html",
      },
    ];
    const checkedPaths: string[] = [];
    const fileService = {
      checkFilesExist: async ({ paths }: { paths: string[] }) =>
        paths.map((path) => {
          checkedPaths.push(path);
          return {
            path,
            exists: path.endsWith("README.md") || path.endsWith("index.html"),
          };
        }),
    };

    await expect(resolveValidatedAssistantPreviewCards(cards, fileService)).resolves.toEqual([
      cards[0],
      cards[2],
    ]);
    expect(checkedPaths).toEqual([
      "/workspace/README.md",
      "/workspace/missing.md",
      "/workspace/index.html",
    ]);
  });
});
