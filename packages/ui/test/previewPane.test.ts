import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  getPreviewPaneSafeErrorMessage,
  getPreviewPaneDisplayOptions,
  isPreviewPaneFileTooLargeError,
  isPptxPreviewFileTooLarge,
  isPreviewPaneMissingFileError,
  shouldToastPptxReferenceFileMissing,
  resolvePptxPreviewReadErrorMessage,
  resolvePreviewPaneImageSource,
  resolvePreviewPaneMediaSource,
  resolveMediaPlaybackErrorMessageId,
  resolvePreviewPanePdfSource,
  resolvePreviewPanePptxSource,
  resolvePreviewPaneTextFileResult,
  shouldShowPreviewPaneHeaderDivider,
} from "@/PreviewPane.js";
import { createDiffSourceFilePreviewSource, getDiffSourceFileTarget } from "@/lib/codeViewer.js";
import { getPreviewPaneErrorTextClass } from "@/previewPaneContent.js";

describe("PreviewPane helpers", () => {
  it.each([
    [3, "codeViewer.mediaUnsupported"],
    [4, "codeViewer.mediaUnsupported"],
    [2, "codeViewer.mediaLoadFailed"],
    [1, "codeViewer.mediaLoadFailed"],
    [undefined, "codeViewer.mediaLoadFailed"],
  ])("classifies media error code %s", (code, expectedMessageId) => {
    expect(resolveMediaPlaybackErrorMessageId(code)).toBe(expectedMessageId);
  });

  it("媒体预览只走 mediaPreviewService，不回退到 file.readMediaPreview", () => {
    const source = readFileSync("packages/ui/src/PreviewPane.tsx", "utf8");
    const mediaEffectStart = source.indexOf("if (!mediaSource)");
    const mediaEffectEnd = source.indexOf("  useEffect(() => {", mediaEffectStart + 1);
    const mediaEffect = source.slice(mediaEffectStart, mediaEffectEnd);

    expect(mediaEffectStart).toBeGreaterThan(0);
    expect(mediaEffect).toContain("mediaPreviewService");
    expect(mediaEffect).toContain(".prepare({");
    expect(mediaEffect).not.toContain("fileService.readMediaPreview");
    expect(mediaEffect.indexOf("preparedPreviewId = previewId")).toBeLessThan(
      mediaEffect.indexOf("generation !== mediaPreviewGenerationRef.current"),
    );
  });

  it("媒体播放器错误时支持通过 service 刷新 URL 并恢复播放状态", () => {
    const source = readFileSync("packages/ui/src/PreviewPane.tsx", "utf8");
    expect(source).toContain("refreshPlaybackUrl");
    expect(source).toContain("mediaPlaybackRestoreRef");
    expect(source).toContain("onMediaLoadedMetadata");
    expect(source).toContain("mediaPreviewGenerationRef");
  });

  it.each([
    ["clip.mp4", "video", "video/mp4"],
    ["clip.mov", "video", "video/quicktime"],
    ["clip.webm", "video", "video/webm"],
    ["clip.m4v", "video", "video/x-m4v"],
    ["song.mp3", "audio", "audio/mpeg"],
    ["song.wav", "audio", "audio/wav"],
    ["song.m4a", "audio", "audio/mp4"],
    ["song.ogg", "audio", "audio/ogg"],
    ["song.opus", "audio", "audio/opus"],
    ["song.flac", "audio", "audio/flac"],
    ["song.weba", "audio", "audio/webm"],
  ])("upgrades %s to a media source", (name, kind, mediaType) => {
    expect(
      resolvePreviewPaneMediaSource({
        type: "file",
        title: name,
        path: `/workspace/${name}`,
      }),
    ).toMatchObject({
      type: "media",
      kind,
      mediaType,
      path: `/workspace/${name}`,
    });
  });

  it.each(["report.docx", "report.doc", "table.xlsx", "table.xls", "slides.pptx", "paper.pdf"])(
    "shows the document header divider for %s",
    (path) => {
      expect(
        shouldShowPreviewPaneHeaderDivider({
          type: "file",
          title: path,
          path: `/workspace/${path}`,
        }),
      ).toBe(true);
    },
  );

  it("does not add the document header divider to ordinary previews", () => {
    expect(
      shouldShowPreviewPaneHeaderDivider({
        type: "file",
        title: "app.ts",
        path: "/workspace/app.ts",
      }),
    ).toBe(false);
  });

  it("keeps the diff source header action visible as text", () => {
    const source = readFileSync("packages/ui/src/PreviewPane.tsx", "utf8");
    const triggerIndex = source.indexOf("data-diff-source-preview-trigger");
    const triggerSource = source.slice(triggerIndex - 600, triggerIndex + 800);

    expect(triggerIndex).toBeGreaterThan(0);
    expect(triggerSource).toContain('size="default"');
    expect(triggerSource).toContain("rounded-lg");
    expect(triggerSource).toContain('id: "codeViewer.openSourcePreview"');
    expect(triggerSource).toContain("<span>");
  });

  it("uses the shared open-with ordering for preview pane editor actions", () => {
    const source = readFileSync("packages/ui/src/PreviewPane.tsx", "utf8");
    const editorSelectionIndex = source.indexOf("const editorSelection = useMemo");
    const editorSelectionSource = source.slice(editorSelectionIndex, editorSelectionIndex + 500);

    expect(editorSelectionIndex).toBeGreaterThan(0);
    expect(editorSelectionSource).toContain("resolveWorkspaceEditorSelection({");
    expect(editorSelectionSource).toContain("remoteTarget: openInEditorRemoteTarget");
    expect(source).toContain("const selectedEditor = editorSelection.selectedEditor");
    expect(source).toContain("const [preferredEditorId] = useState");
    expect(source).not.toContain("persistLastSelectedEditorId");
    expect(source).not.toContain("const availableEditors = installedEditors");
  });

  it("uses media preview for raster image file sources", () => {
    expect(
      resolvePreviewPaneImageSource({
        type: "file",
        title: "Lark_Suite_logo_2022.png.png",
        path: "/workspace/Lark_Suite_logo_2022.png.png",
      }),
    ).toEqual({
      type: "image",
      title: "Lark_Suite_logo_2022.png.png",
      path: "/workspace/Lark_Suite_logo_2022.png.png",
      mediaType: "image/png",
    });
  });

  it("keeps svg file sources out of media preview so source mode still works", () => {
    expect(
      resolvePreviewPaneImageSource({
        type: "file",
        title: "logo.svg",
        path: "/workspace/logo.svg",
      }),
    ).toBeNull();
  });

  it("upgrades pdf file sources to the dedicated pdf preview", () => {
    expect(
      resolvePreviewPanePdfSource({
        type: "file",
        title: "report.pdf",
        path: "/workspace/report.pdf",
      }),
    ).toEqual({
      type: "pdf",
      title: "report.pdf",
      path: "/workspace/report.pdf",
    });

    expect(
      resolvePreviewPanePdfSource({
        type: "file",
        title: "REPORT.PDF",
        path: "/workspace/REPORT.PDF",
      }),
    ).toEqual({
      type: "pdf",
      title: "REPORT.PDF",
      path: "/workspace/REPORT.PDF",
    });
  });

  it("passes through pdf sources and rejects non-pdf sources", () => {
    const pdfSource = {
      type: "pdf" as const,
      title: "report.pdf",
      path: "/workspace/report.pdf",
    };
    expect(resolvePreviewPanePdfSource(pdfSource)).toBe(pdfSource);

    expect(
      resolvePreviewPanePdfSource({
        type: "file",
        title: "index.ts",
        path: "/workspace/index.ts",
      }),
    ).toBeNull();
    expect(resolvePreviewPanePdfSource(null)).toBeNull();
  });

  it("hides the more menu for pdf previews", () => {
    // pdf 是专用只读预览，没有源码视图，也不该出现自动换行开关
    expect(
      getPreviewPaneDisplayOptions({
        type: "file",
        title: "report.pdf",
        path: "/workspace/report.pdf",
      }).hasMoreMenu,
    ).toBe(false);

    expect(
      getPreviewPaneDisplayOptions({
        type: "pdf",
        title: "report.pdf",
        path: "/workspace/report.pdf",
      }).hasMoreMenu,
    ).toBe(false);
  });

  it("upgrades pptx file sources and preserves workspace scope", () => {
    const source = {
      type: "file" as const,
      title: "ROADMAP.PPTX",
      path: "/workspace/ROADMAP.PPTX",
      workspacePath: "/workspace",
      workspaceIdentity: "ssh:demo:/workspace",
      workspaceRemoteSessionId: "remote-1",
    };
    expect(resolvePreviewPanePptxSource(source)).toEqual({
      ...source,
      type: "pptx",
    });
  });

  it("passes through pptx sources and rejects non-pptx sources", () => {
    const pptxSource = {
      type: "pptx" as const,
      title: "slides.pptx",
      path: "/workspace/slides.pptx",
    };
    expect(resolvePreviewPanePptxSource(pptxSource)).toBe(pptxSource);
    expect(
      resolvePreviewPanePptxSource({
        type: "file",
        title: "legacy.ppt",
        path: "/workspace/legacy.ppt",
      }),
    ).toBeNull();
    expect(resolvePreviewPanePptxSource(null)).toBeNull();
  });

  it("only requests a missing-file toast for reference-driven PPTX navigation", () => {
    const missingError = Object.assign(new Error("missing"), { code: "ENOENT" });
    expect(
      shouldToastPptxReferenceFileMissing(
        {
          type: "pptx",
          title: "slides.pptx",
          path: "/workspace/slides.pptx",
          referenceNavigation: {
            requestId: "navigation-1",
            pageIndex: 2,
            expectedSourceFingerprint: `sha256:${"a".repeat(64)}`,
          },
        },
        missingError,
      ),
    ).toBe(true);
    expect(
      shouldToastPptxReferenceFileMissing(
        {
          type: "pptx",
          title: "slides.pptx",
          path: "/workspace/slides.pptx",
        },
        missingError,
      ),
    ).toBe(false);
  });

  it("hides the more menu for pptx previews", () => {
    expect(
      getPreviewPaneDisplayOptions({
        type: "file",
        title: "slides.pptx",
        path: "/workspace/slides.pptx",
      }).hasMoreMenu,
    ).toBe(false);
    expect(
      getPreviewPaneDisplayOptions({
        type: "pptx",
        title: "slides.pptx",
        path: "/workspace/slides.pptx",
      }).hasMoreMenu,
    ).toBe(false);
  });

  it("enforces the 64 MB PPTX preview source limit", () => {
    expect(isPptxPreviewFileTooLarge(64 * 1024 * 1024)).toBe(false);
    expect(isPptxPreviewFileTooLarge(64 * 1024 * 1024 + 1)).toBe(true);
  });

  it("keeps PPTX rendering lazy and uses DESIGN typography tokens", () => {
    const contentSource = readFileSync("packages/ui/src/previewPanePptxContent.tsx", "utf8");
    const viewerSource = readFileSync(
      "packages/ui/src/components/ui/pptx-preview-viewer.tsx",
      "utf8",
    );

    expect(contentSource).toContain("lazy(() =>");
    expect(viewerSource).toContain('import("@/presentation/pptxRendererPreviewEngine.js")');
    expect(viewerSource).toContain("IntersectionObserver");
    expect(viewerSource).not.toMatch(/\btext-(?:xs|sm|base|lg|xl)\b/);
    expect(viewerSource.match(/\bbg-surface\/30\b/g)).toHaveLength(2);
  });

  it("hides the more menu when a preview source has no display options", () => {
    expect(
      getPreviewPaneDisplayOptions({
        type: "image",
        title: "logo.png",
        path: "/workspace/logo.png",
        mediaType: "image/png",
      }).hasMoreMenu,
    ).toBe(false);

    expect(
      getPreviewPaneDisplayOptions({
        type: "patch",
        title: "changes.patch",
        patch: "diff --git a/a b/a",
      }).hasMoreMenu,
    ).toBe(false);

    expect(
      getPreviewPaneDisplayOptions({
        type: "multi-file-diff",
        title: "changes.patch",
        path: "/workspace/app.ts",
        beforeContent: "const value = 1;",
        afterContent: "const value = 2;",
      }).hasMoreMenu,
    ).toBe(false);

    expect(
      getPreviewPaneDisplayOptions({
        type: "file",
        title: "logo.png",
        path: "/workspace/logo.png",
      }).hasMoreMenu,
    ).toBe(false);

    expect(
      getPreviewPaneDisplayOptions({
        type: "file",
        title: "report.xlsx",
        path: "/workspace/report.xlsx",
      }).hasMoreMenu,
    ).toBe(false);

    expect(
      getPreviewPaneDisplayOptions({
        type: "file",
        title: "proposal.docx",
        path: "/workspace/proposal.docx",
      }).hasMoreMenu,
    ).toBe(false);

    expect(
      getPreviewPaneDisplayOptions({
        type: "file",
        title: "legacy.doc",
        path: "/workspace/legacy.doc",
      }).hasMoreMenu,
    ).toBe(false);
  });

  it("shows the more menu when a preview source has display options", () => {
    expect(
      getPreviewPaneDisplayOptions({
        type: "text",
        title: "README.md",
        path: "/workspace/README.md",
        content: "# Title",
        language: "markdown",
      }).hasMoreMenu,
    ).toBe(true);

    expect(
      getPreviewPaneDisplayOptions({
        type: "file",
        title: "logo.svg",
        path: "/workspace/logo.svg",
      }).hasMoreMenu,
    ).toBe(true);

    expect(
      getPreviewPaneDisplayOptions({
        type: "text",
        title: "index.ts",
        content: "export {};",
        language: "typescript",
      }).hasMoreMenu,
    ).toBe(true);
  });

  it("keeps code-review sources in code mode with only the wrap control", () => {
    const options = getPreviewPaneDisplayOptions({
      type: "code-review",
      title: "README.md",
      path: "/workspace/README.md",
      workspacePath: "/workspace",
      review: {
        requestId: "review-1",
        title: "Review title",
        body: "Review body",
      },
    });

    expect(options).toEqual({
      canToggleCodeWrap: true,
      canToggleMarkdownView: false,
      canToggleSvgView: false,
      hasMoreMenu: true,
    });
  });

  it("shows the wrap option after svg is switched to code mode", () => {
    const svgSource = {
      type: "file" as const,
      title: "logo.svg",
      path: "/workspace/logo.svg",
    };

    expect(
      getPreviewPaneDisplayOptions(svgSource, {
        svgViewMode: "preview",
      }).canToggleCodeWrap,
    ).toBe(false);

    expect(
      getPreviewPaneDisplayOptions(svgSource, {
        svgViewMode: "code",
      }).canToggleCodeWrap,
    ).toBe(true);
  });

  it("detects missing-file preview errors without depending on platform error objects", () => {
    expect(
      isPreviewPaneMissingFileError(
        new Error(
          "ENOENT: no such file or directory, stat 'D:\\CODE\\Demo_OCR\\OCR4-Ollama-Bundle\\paper.md'",
        ),
      ),
    ).toBe(true);

    expect(isPreviewPaneMissingFileError({ code: "ENOENT" })).toBe(true);
    expect(isPreviewPaneMissingFileError(new Error("permission denied"))).toBe(false);
  });

  it("detects the bounded binary preview size error for localized UI copy", () => {
    expect(
      isPreviewPaneFileTooLargeError(new Error("File is too large to preview: 26214401 bytes")),
    ).toBe(true);
    expect(isPreviewPaneFileTooLargeError(new Error("permission denied"))).toBe(false);
  });

  it("only treats truncated text as too large and preserves binary detection", () => {
    const truncatedText = {
      path: "/workspace/large.log",
      content: "partial",
      offset: 0,
      bytesRead: 256 * 1024,
      totalBytes: 256 * 1024 + 1,
      truncated: true,
      isBinary: false,
    };
    const truncatedBinary = {
      ...truncatedText,
      content: "",
      isBinary: true,
    };

    expect(resolvePreviewPaneTextFileResult(truncatedText)).toEqual({
      filePreview: null,
      fileTooLarge: true,
    });
    expect(resolvePreviewPaneTextFileResult(truncatedBinary)).toEqual({
      filePreview: truncatedBinary,
      fileTooLarge: false,
    });
  });

  it("maps the old remote PPTX 8 MB limit without exposing its absolute path", () => {
    const sourcePath = "/srv/private/customer/slides.pptx";
    const message = resolvePptxPreviewReadErrorMessage(
      new Error(`File is too large to preview: ${sourcePath}`),
      {
        sourcePath,
        fileMissingMessage: "missing",
        legacyFileTooLargeMessage: "legacy 8 MB limit",
        incompleteFileMessage: "incomplete",
      },
    );

    expect(message).toBe("legacy 8 MB limit");
    expect(message).not.toContain("/srv/private/customer");
  });

  it("keeps only the file name when another PPTX read error contains an absolute path", () => {
    expect(
      getPreviewPaneSafeErrorMessage(
        new Error("Permission denied: D:\\private\\customer\\slides.pptx"),
        "D:\\private\\customer\\slides.pptx",
      ),
    ).toBe("Permission denied: slides.pptx");
  });

  it("routes Office files through the bounded binary preview service", () => {
    const source = readFileSync("packages/ui/src/PreviewPane.tsx", "utf8");

    expect(source).toContain(".readBinaryPreview({ path: source.path })");
    expect(source).toMatch(/!imageSource\s*&&\s*!pdfSource\s*&&\s*!officePreviewKind/);
  });

  it("renders missing-file preview errors as tertiary helper text", () => {
    const missingFileMessage = "文件不存在，或当前环境无法访问该路径。";

    expect(getPreviewPaneErrorTextClass(missingFileMessage, missingFileMessage)).toBe(
      "text-foreground-subtlest",
    );
    expect(getPreviewPaneErrorTextClass("permission denied", missingFileMessage)).toBe(
      "text-destructive",
    );
  });

  it("reads scroll metrics from the real preview content scroller", async () => {
    const previewPaneModule = await import("@/PreviewPane.js");

    expect(typeof previewPaneModule.readPreviewPaneScrollMetrics).toBe("function");

    expect(
      previewPaneModule.readPreviewPaneScrollMetrics({
        scrollHeight: 2400,
        scrollTop: 720,
      }),
    ).toEqual({
      scrollHeight: 2400,
      scrollTop: 720,
    });
  });

  it("wires scroll memory through to the CodeViewer scroll container", () => {
    const previewPaneSource = readFileSync("packages/ui/src/PreviewPane.tsx", "utf8");
    const contentSource = readFileSync("packages/ui/src/previewPaneContent.tsx", "utf8");
    const codeContentSource = readFileSync("packages/ui/src/previewPaneCodeContent.tsx", "utf8");
    const codeViewerSource = readFileSync("packages/ui/src/components/ui/code-viewer.tsx", "utf8");

    expect(previewPaneSource).toContain("scrollContainerRef={scrollContainerRef}");
    expect(contentSource).toContain("scrollContainerRef?: Ref<HTMLDivElement>");
    expect(codeContentSource).toContain("scrollContainerRef?: Ref<HTMLDivElement>");
    expect(codeViewerSource).toContain("assignCodeViewerScrollContainerRef");
  });

  it("builds a normal file preview source from diff preview sources", () => {
    expect(
      createDiffSourceFilePreviewSource(
        {
          type: "multi-file-diff",
          title: "demo.ts",
          path: "/workspace/demo.ts",
          beforeContent: "const value = 1;",
          afterContent: "const value = 2;",
          workspaceIdentity: "ssh:test:/workspace",
          workspaceRemoteSessionId: "remote-1",
        },
        "/workspace",
      ),
    ).toEqual({
      type: "file",
      title: "demo.ts",
      path: "/workspace/demo.ts",
      workspacePath: "/workspace",
      workspaceIdentity: "ssh:test:/workspace",
      workspaceRemoteSessionId: "remote-1",
    });

    expect(
      createDiffSourceFilePreviewSource(
        {
          type: "patch",
          title: "Diff",
          patch: [
            "diff --git a/src/demo.ts b/src/demo.ts",
            "--- a/src/demo.ts",
            "+++ b/src/demo.ts",
            "@@ -1 +1 @@",
            "-old",
            "+new",
          ].join("\n"),
        },
        "/workspace",
      ),
    ).toEqual({
      type: "file",
      title: "demo.ts",
      path: "/workspace/src/demo.ts",
      workspacePath: "/workspace",
    });
  });

  it("uses deletion patch headers but refuses relative paths without workspace scope", () => {
    const deletionPatch = [
      "diff --git a/src/deleted.ts b/src/deleted.ts",
      "--- a/src/deleted.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-old",
    ].join("\n");

    expect(
      getDiffSourceFileTarget({
        type: "patch",
        title: "Diff",
        patch: deletionPatch,
      }),
    ).toBe("src/deleted.ts");

    expect(
      createDiffSourceFilePreviewSource({
        type: "patch",
        title: "Diff",
        patch: deletionPatch,
      }),
    ).toBeNull();
  });
});
