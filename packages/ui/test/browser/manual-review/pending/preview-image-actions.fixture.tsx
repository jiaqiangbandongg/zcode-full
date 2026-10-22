import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ImagePreviewContent, SvgPreviewContent } from "@/previewPaneImageContent.js";
import { resolvePreviewPaneImageFileReference } from "@/PreviewPane.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import {
  WORKSPACE_FILE_ADD_TO_CHAT_EVENT,
  createWorkspaceFileComposerMention,
} from "@/lib/workspaceFileDrag.js";
import "@/styles.css";

const params = new URLSearchParams(location.search);
const locale = params.get("locale") === "en-US" ? "en-US" : "zh-CN";
localStorage.setItem("zcode-locale-preference", locale);
document.documentElement.className =
  params.get("theme") === "light" ? "theme-zai-light" : "theme-zai-dark dark";
const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="300"><rect width="480" height="300" fill="white"/><circle cx="140" cy="150" r="70" fill="#d1fae5" stroke="#059669" stroke-width="3"/><path d="M300 80l70 40v80l-70 40-70-40v-80z" fill="#e0e7ff" stroke="#6366f1" stroke-width="3"/></svg>';
const canvas = document.createElement("canvas");
canvas.width = 64;
canvas.height = 48;
canvas.getContext("2d")!.fillRect(0, 0, 32, 48);
const kind = params.get("kind") === "png" ? "png" : "svg";
const source = {
  type: "file" as const,
  title: `drawing.${kind}`,
  path: `${params.get("source") === "outside" ? "/outside" : "/project"}/drawing.${kind}`,
  workspacePath: "/project",
};
const ref = resolvePreviewPaneImageFileReference(source, "/project", "/project")!;

function Fixture() {
  const [draft, setDraft] = useState("existing draft");
  useEffect(() => {
    const onAdd = (event: Event) => {
      event.preventDefault();
      const mention = createWorkspaceFileComposerMention((event as CustomEvent).detail, "/project");
      setDraft((text) => `${text} ${mention.markdown}`);
    };
    window.addEventListener(WORKSPACE_FILE_ADD_TO_CHAT_EVENT, onAdd);
    return () => window.removeEventListener(WORKSPACE_FILE_ADD_TO_CHAT_EVENT, onAdd);
  }, []);
  return (
    <ZCodeIntlProvider initialLocale={locale}>
      <div style={{ height: "calc(100% - 52px)" }}>
        {kind === "svg" ? (
          <SvgPreviewContent title={ref.name} svgContent={svg} fileReference={ref} />
        ) : (
          <ImagePreviewContent
            title={ref.name}
            imageSource={canvas.toDataURL()}
            fileReference={ref}
          />
        )}
      </div>
      <textarea aria-label="Draft" readOnly value={draft} style={{ width: "100%", height: 52 }} />
    </ZCodeIntlProvider>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
