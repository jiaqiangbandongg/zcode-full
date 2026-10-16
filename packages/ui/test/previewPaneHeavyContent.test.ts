import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";

vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => ({
    getInstalledEditors: async () => [],
    openInEditor: async () => ({ success: false }),
  }),
}));

vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useWorkspaceServices: () => ({
    fileService: {
      readMediaPreview: vi.fn(),
      readTextFile: vi.fn(),
    },
  }),
}));

vi.mock("@/store/StoreProvider.js", () => ({
  useZCodeStore: <T,>(selector: (state: Record<string, unknown>) => T) =>
    selector({
      codePreviewSettings: {
        darkTheme: "github-dark",
        fontSizePx: 12,
        lightTheme: "github-light",
        showLineNumbers: true,
        wrapLongLines: false,
      },
      theme: "dark",
    }),
}));

vi.mock("@/store/codeCommentPreviewStore.js", () => ({
  useCodeCommentPreviewStore: <T,>(
    selector: (state: Record<string, unknown>) => T,
  ) =>
    selector({
      addComment: vi.fn(),
      getComments: () => [],
      removeComment: vi.fn(),
    }),
}));

vi.mock("@/previewPaneContent.js", () => ({
  PreviewPaneContent: () =>
    createElement("div", { "data-preview-pane-content": "mounted" }),
}));

async function renderPreviewPane(renderHeavyContent: boolean) {
  const { PreviewPane } = await import("@/PreviewPane.js");

  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "en-US" },
      createElement(PreviewPane, {
        onClose: vi.fn(),
        renderHeavyContent,
        source: {
          type: "text",
          title: "demo.ts",
          content: "const value = 1;",
          language: "typescript",
        },
        workspacePath: "/workspace",
      }),
    ),
  );
}

describe("PreviewPane heavy content gate", () => {
  it("mounts PreviewPaneContent while heavy content is allowed", async () => {
    const html = await renderPreviewPane(true);

    expect(html).toContain('data-preview-pane-content="mounted"');
    expect(html).not.toContain("data-preview-pane-heavy-content-deferred");
  });

  it("defers PreviewPaneContent while heavy content is disallowed", async () => {
    const html = await renderPreviewPane(false);

    expect(html).not.toContain('data-preview-pane-content="mounted"');
    expect(html).toContain('data-preview-pane-heavy-content-deferred="true"');
    expect(html).toContain('data-preview-pane-heavy-content-placeholder="true"');
  });
});
