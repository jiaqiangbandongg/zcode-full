// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenSplitButton, type OpenSplitButtonTarget } from "@/OpenSplitButton.js";
import { toast } from "@/components/ui/toast.js";
import type { OpenInEditorRemoteTarget } from "@zcode/shared";

const state = vi.hoisted(() => ({
  native: true,
  remote: false,
  remoteTarget: undefined as OpenInEditorRemoteTarget | undefined,
  openInEditor: vi.fn(),
  openExternalFile: vi.fn(),
  openInFileManager: vi.fn(),
  getInstalledEditors: vi.fn(),
  openExternal: vi.fn(),
  writeText: vi.fn(),
}));
vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => ({
    canOpenLocalFiles: state.native,
    openExternalFile: state.openExternalFile,
    openInFileManager: state.openInFileManager,
    getInstalledEditors: state.getInstalledEditors,
    openExternal: state.openExternal,
    openInEditor: state.openInEditor,
  }),
}));
vi.mock("@/hooks/useWorkspaceOpenInEditorTarget.js", () => ({
  useWorkspaceOpenInEditorTarget: () => ({
    isRemoteWorkspace: state.remote,
    remoteTarget: state.remoteTarget,
  }),
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));
vi.mock("@/components/ui/toast.js", () => ({ toast: vi.fn() }));
const file: OpenSplitButtonTarget = {
  type: "file",
  path: "/workspace/space name/report.pptx",
  title: "report.pptx",
  label: "report.pptx",
  previewSource: {
    type: "file",
    path: "/workspace/space name/report.pptx",
    title: "report.pptx",
    workspacePath: "/workspace",
  },
};
function mount(target: OpenSplitButtonTarget = file) {
  const preview = vi.fn();
  render(
    createElement(OpenSplitButton, {
      target,
      onOpenCodeViewer: preview,
      onOpenBrowserUrl: preview,
      renderCard: (button) =>
        createElement("div", { "data-testid": "card" }, "report.pptx", button),
    }),
  );
  return preview;
}
function openContext() {
  fireEvent.contextMenu(screen.getByTestId("card"), { button: 2, clientX: 30, clientY: 30 });
}
afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  state.native = true;
  state.remote = false;
  state.remoteTarget = undefined;
  state.openInEditor.mockResolvedValue({ success: true });
  state.openExternalFile.mockResolvedValue({ success: true });
  state.openInFileManager.mockResolvedValue({ success: true });
  state.getInstalledEditors.mockResolvedValue([]);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: state.writeText },
  });
  state.writeText.mockResolvedValue(undefined);
});
describe("preview card actions", () => {
  it("context menu previews the same scoped source as the primary button", () => {
    const preview = mount();
    openContext();
    fireEvent.click(screen.getByText("chat.previewCards.previewInSidePane"));
    expect(preview).toHaveBeenCalledWith(file.previewSource);
  });
  it("keeps the original Open button and flat dropdown while retaining context actions", async () => {
    mount();
    expect(screen.getByRole("button", { name: "common.open" })).toBeTruthy();
    openContext();
    await waitFor(() => expect(state.getInstalledEditors).toHaveBeenCalledWith(file.path));
    expect(screen.getByText("chat.previewCards.previewInSidePane")).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    fireEvent.pointerDown(screen.getByLabelText("appHeader.selectOpenApp"), {
      button: 0,
      ctrlKey: false,
    });
    await screen.findByText("chat.previewCards.noOpenApps");
    expect(screen.getAllByRole("menuitem").map((el) => el.textContent)).toEqual([
      "chat.previewCards.noOpenApps",
      "fileActions.copyAbsolutePath",
      "fileActions.copyRelativePath",
    ]);
    expect(screen.queryByText("chat.previewCards.previewInSidePane")).toBeNull();
    expect(screen.queryByText("chat.previewCards.openDefaultApp")).toBeNull();
    expect(screen.queryByText("chat.previewCards.openContainingDirectory")).toBeNull();
  });
  it("uses native file opening and omits the containing directory", async () => {
    mount();
    openContext();
    fireEvent.click(screen.getByText("chat.previewCards.openDefaultApp"));
    await waitFor(() => expect(state.openExternalFile).toHaveBeenCalledWith(file.path));
    openContext();
    expect(screen.queryByText("chat.previewCards.openContainingDirectory")).toBeNull();
    expect(screen.getAllByRole("menuitem").map((el) => el.textContent)).toEqual([
      "chat.previewCards.previewInSidePane",
      "chat.previewCards.openDefaultApp",
      "chat.previewCards.openWith",
      "fileActions.copyRelativePath",
      "fileActions.copyAbsolutePath",
    ]);
    expect(state.openInFileManager).not.toHaveBeenCalled();
  });
  it.each(["web", "remote"])("omits unsafe native actions on %s", (mode) => {
    state.native = mode !== "web";
    state.remote = mode === "remote";
    mount();
    openContext();
    expect(screen.queryByText("chat.previewCards.openDefaultApp")).toBeNull();
    expect(screen.queryByText("chat.previewCards.openContainingDirectory")).toBeNull();
    expect(screen.queryByText("chat.previewCards.openWith")).toBeNull();
    expect(screen.getByText("fileActions.copyAbsolutePath")).toBeTruthy();
  });
  it("mobile retains its existing Open button preview behavior", () => {
    state.native = false;
    const preview = mount();
    fireEvent.click(screen.getByRole("button", { name: "common.open" }));
    expect(preview).toHaveBeenCalledWith(file.previewSource);
    expect(state.getInstalledEditors).not.toHaveBeenCalled();
  });
  it("URL-only website opens the original browser URL", () => {
    const url = "http://localhost:5173/page?x=1";
    mount({ type: "website", url });
    openContext();
    fireEvent.click(screen.getByRole("menuitem", { name: "common.open" }));
    expect(state.openExternal).toHaveBeenCalledWith(url);
    expect(state.openExternalFile).not.toHaveBeenCalled();
  });
  it("file-backed HTML uses the local file browser route", () => {
    mount({
      type: "website",
      url: "file:///workspace/index.html",
      localPath: "/workspace/index.html",
    });
    openContext();
    fireEvent.click(screen.getByRole("menuitem", { name: "common.open" }));
    expect(state.openExternalFile).toHaveBeenCalledWith("/workspace/index.html");
  });
  it("copies website URLs and omits file actions for URL-only cards", async () => {
    mount({ type: "website", url: "http://localhost:5173/page?x=1" });
    openContext();
    fireEvent.click(screen.getByText("chat.previewCards.copyLink"));
    await waitFor(() =>
      expect(state.writeText).toHaveBeenCalledWith("http://localhost:5173/page?x=1"),
    );
    openContext();
    expect(screen.queryByText("fileActions.copyRelativePath")).toBeNull();
  });
  it("file-backed HTML omits containing-directory and retains path actions", async () => {
    mount({
      type: "website",
      url: "file:///workspace/index.html",
      localPath: "/workspace/index.html",
      workspacePath: "/workspace",
    });
    openContext();
    expect(screen.queryByText("chat.previewCards.openContainingDirectory")).toBeNull();
    fireEvent.click(screen.getByText("fileActions.copyRelativePath"));
    await waitFor(() => expect(state.writeText).toHaveBeenCalledWith("index.html"));
  });
});

describe("preview editor failures", () => {
  it.each(["result", "rejection"])(
    "shows a toast for %s failures after filtering SSH apps",
    async (failure) => {
      state.remote = true;
      state.remoteTarget = {
        kind: "ssh",
        host: "example.com",
        username: "dev",
        port: 22,
      } as OpenInEditorRemoteTarget;
      state.getInstalledEditors.mockResolvedValue([
        { id: "vscode", name: "VS Code", iconDataUrl: "" },
        { id: "word", name: "Word", iconDataUrl: "" },
      ]);
      if (failure === "result")
        state.openInEditor.mockResolvedValue({ success: false, error: "failed" });
      else state.openInEditor.mockRejectedValue(new Error("failed"));
      mount();
      fireEvent.pointerDown(screen.getByLabelText("appHeader.selectOpenApp"), {
        button: 0,
        ctrlKey: false,
      });
      await screen.findByRole("menuitem", { name: /VS Code/ });
      expect(screen.queryByRole("menuitem", { name: /Word/ })).toBeNull();
      fireEvent.click(screen.getByRole("menuitem", { name: /VS Code/ }));
      await waitFor(() => expect(toast).toHaveBeenCalledWith("chat.previewCards.openFileFailed"));
      expect(state.openInEditor).toHaveBeenCalledWith(
        "vscode",
        file.path,
        expect.objectContaining({ remoteTarget: state.remoteTarget }),
      );
    },
  );
});
