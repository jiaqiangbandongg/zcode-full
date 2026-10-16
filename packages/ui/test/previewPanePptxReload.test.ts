// @vitest-environment jsdom

import { act, render, screen, waitFor } from "@testing-library/react";
import { Emitter } from "@zcode/rpc";
import type { FileWatchEvent } from "@zcode/shared";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";

const h = vi.hoisted(() => ({
  currentByte: 1,
  readFileRange: vi.fn(),
  stat: vi.fn(),
  unwatch: vi.fn(),
  watch: vi.fn(),
}));
const watcherEmitter = new Emitter<FileWatchEvent>();

vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => ({
    getInstalledEditors: async () => [],
    openInEditor: async () => ({ success: false }),
  }),
}));

vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useWorkspaceServices: (() => {
    const services = {
    fileService: {
      readFileRange: h.readFileRange,
      stat: h.stat,
    },
    fileWatcherService: {
      watch: h.watch,
      unwatch: h.unwatch,
      disposeAll: vi.fn(),
      onDynamicChange: () => watcherEmitter.event,
    },
    };
    return () => services;
  })(),
}));

vi.mock("@/hooks/useFileContextActions.js", () => ({
  useFileContextActions: () => ({
    copyAbsolutePath: vi.fn(),
    copyRelativePath: vi.fn(),
  }),
}));

vi.mock("@/hooks/useWorkspaceOpenInEditorTarget.js", () => ({
  useWorkspaceOpenInEditorTarget: () => ({
    isRemoteWorkspace: false,
    remoteTarget: null,
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
  PreviewPaneContent: ({ pptxPreviewData }: { pptxPreviewData: ArrayBuffer | null }) =>
    createElement(
      "div",
      { "data-testid": "pptx-preview-byte" },
      pptxPreviewData ? new Uint8Array(pptxPreviewData)[0] : "empty",
    ),
}));

afterEach(() => {
  h.currentByte = 1;
  h.readFileRange.mockReset();
  h.stat.mockReset();
  h.unwatch.mockReset();
  h.watch.mockReset();
});

describe("PreviewPane PPTX file reload", () => {
  it("watches before the initial read and reloads the target file through the same service", async () => {
    h.watch.mockResolvedValue({ id: "pptx-watch" });
    h.unwatch.mockResolvedValue(undefined);
    h.stat.mockResolvedValue({
      path: "/workspace/deck.pptx",
      type: "file",
      size: 1,
    });
    h.readFileRange.mockImplementation(async () => Uint8Array.of(h.currentByte));

    const { PreviewPane } = await import("@/PreviewPane.js");
    const view = render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(PreviewPane, {
          onClose: vi.fn(),
          source: {
            type: "file",
            title: "deck.pptx",
            path: "/workspace/deck.pptx",
          },
          workspacePath: "/workspace",
        }),
      ),
    );

    expect(h.readFileRange).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByTestId("pptx-preview-byte").textContent).toBe("1"));
    expect(h.watch).toHaveBeenCalledWith({ path: "/workspace" });

    h.currentByte = 2;
    act(() => {
      watcherEmitter.fire({
        dirPath: "/workspace",
        changedPath: "/workspace/deck.pptx",
      });
    });
    await waitFor(() => expect(screen.getByTestId("pptx-preview-byte").textContent).toBe("2"));
    expect(h.readFileRange).toHaveBeenCalledTimes(2);

    view.unmount();
    await waitFor(() => expect(h.unwatch).toHaveBeenCalledWith({ id: "pptx-watch" }));
  });
});
