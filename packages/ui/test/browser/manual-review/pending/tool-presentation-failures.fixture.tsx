import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { FileMediaPreview, IPlatformService } from "@zcode/shared";
import { ToolCallBody } from "@/ToolCallBlocks/ToolCallBody.js";
import { ToolPresentationCapabilitiesProvider } from "@/ToolCallBlocks/presentationCapabilities.js";
import { OpenSplitButton } from "@/OpenSplitButton.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { TabStoreProvider, useTabStoreApi } from "@/store/TabStoreProvider.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import "@/styles.css";
const params = new URLSearchParams(location.search);
const icon =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9K0AAAAASUVORK5CYII=";
document.documentElement.className = `${params.get("theme")} theme-zai-${params.get("theme")}`;
let releaseOld: ((value: FileMediaPreview) => void) | undefined;
const readMediaPreview = async (path: string): Promise<FileMediaPreview> => {
  if (path === "failure") throw new Error("fixture image read failure");
  if (path === "pending")
    return new Promise((resolve) => {
      releaseOld = resolve;
    });
  return { path, dataBase64: path === "empty" ? "" : icon, totalBytes: 1, mediaType: "image/png" };
};
const platform = {
  canOpenLocalFiles: true,
  getInstalledEditors: async () => [
    { id: "vscode", name: "VS Code", iconDataUrl: icon },
    { id: "word", name: "Word", iconDataUrl: icon },
  ],
  openInEditor: async (_id: string, _path: string, options: unknown) => {
    document.querySelector("#opened")!.textContent = JSON.stringify(options);
    if (params.get("failure") === "reject") throw new Error("fixture open rejection");
    return { success: false, error: "fixture open failure" };
  },
} as unknown as IPlatformService;
function Fixture() {
  const tabs = useTabStoreApi();
  const [path, setPath] = useState("pending");
  useEffect(() => {
    tabs.getState().addTab("/workspace", {
      workspaceIdentity: "remote-fixture",
      remoteTarget: { kind: "ssh", host: "example.com", username: "dev" },
    });
  }, [tabs]);
  return (
    <main className="min-h-screen bg-background text-foreground p-4 space-y-4">
      <div className="flex flex-wrap gap-2">
        {["pending", "failure", "empty", "success"].map((value) => (
          <Button key={value} onClick={() => setPath(value)}>
            {value}
          </Button>
        ))}
        <Button
          onClick={() =>
            releaseOld?.({
              path: "old",
              dataBase64: "old-image",
              totalBytes: 1,
              mediaType: "image/png",
            })
          }
        >
          release old
        </Button>
      </div>
      <section data-testid="image-preview">
        <ToolPresentationCapabilitiesProvider value={{ readMediaPreview }}>
          <ToolCallBody
            childToolList={null}
            workspacePath="/workspace"
            toolCall={{ toolId: "image", kind: "read", status: "completed" }}
            displayModel={{
              inlinePreview: {
                type: "image",
                source: { type: "image", title: "Tool image", path },
              },
              planResult: null,
              viewerSource: null,
              viewerLabelId: "codeViewer.viewCode",
              showSummaryFileLink: false,
              showInput: false,
              showOutput: false,
              showKind: false,
            }}
          />
        </ToolPresentationCapabilitiesProvider>
      </section>
      <OpenSplitButton
        target={{
          type: "file",
          title: "Report",
          label: "Report",
          path: "/workspace/report.docx",
          previewSource: {
            type: "file",
            title: "Report",
            path: "/workspace/report.docx",
            workspacePath: "/workspace",
            workspaceIdentity: "remote-fixture",
          },
        }}
        onOpenCodeViewer={() => {}}
        renderCard={(button) => <div data-testid="file-card">Report{button}</div>}
      />
      <output id="opened" className="break-all" />
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <ZCodeIntlProvider initialLocale={params.get("locale") === "en-US" ? "en-US" : "zh-CN"}>
    <PlatformProvider platform={platform}>
      <TabStoreProvider>
        <Fixture />
      </TabStoreProvider>
    </PlatformProvider>
  </ZCodeIntlProvider>,
);
