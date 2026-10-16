import { basename } from "../deps.js";
import type { FilePartSource, TurnAttachment } from "../deps.js";
import type { ResolvedTurnAttachment } from "../types.js";
import { safeAttachmentOriginalRef } from "./attachment-artifacts.js";
import { inferVideoMimeFromPath } from "./attachment-video.js";

type PathReferenceReason =
  | "binary_file"
  | "deferred_clipboard_text"
  | "deferred_topic_history"
  | "image_too_large"
  | "pdf_too_large"
  | "text_too_large"
  | "video_too_large";

export function resolvedInlineTextAttachment(
  attachment: TurnAttachment,
  index: number,
): ResolvedTurnAttachment {
  const content = attachment.content ?? "";
  const placeholder = attachment.path ?? `attachment-${index + 1}`;
  return {
    contentBlock: { type: "text", text: content },
    filename: attachment.path ? basename(attachment.path) : undefined,
    metadata: {
      originalUrl: safeAttachmentOriginalRef(attachment),
      preview: {
        text: content,
        truncated: false,
        originalBytes: Buffer.byteLength(content, "utf8"),
      },
      recoverability: "provider_ready",
      sizeBytes: Buffer.byteLength(content, "utf8"),
      storageKind: "inline",
    },
    mime: "text/plain",
    url: placeholder,
  };
}

export function resolvedPathReferenceAttachment(
  attachment: TurnAttachment,
  placeholder: string,
  options: {
    filename?: string;
    mime?: string;
    reason: PathReferenceReason;
    sizeBytes?: number;
    source?: FilePartSource;
  },
): ResolvedTurnAttachment {
  const mime =
    options.mime ?? (attachment.type === "image" ? "image/*" : "application/octet-stream");
  const content = [
    `Attached ${mime}: ${placeholder}`,
    `The file was sent by local path because ${formatPathReferenceReason(options.reason)}.`,
    "Use the available file reading tools if you need to inspect the file contents.",
  ].join("\n");
  return {
    contentBlock: { type: "text", text: content },
    filename: options.filename,
    metadata: {
      originalUrl: safeAttachmentOriginalRef(attachment),
      recoverability: "metadata_only",
      sizeBytes: options.sizeBytes,
      storageKind: "local_ref",
    },
    mime,
    source: options.source,
    url: attachment.path ?? attachment.content ?? "",
  };
}

export function isDataOrArtifactUrl(content: string): boolean {
  return content.startsWith("data:") || content.startsWith("zcode-artifact://");
}

export function isTextLikePath(path: string): boolean {
  return /\.(cjs|conf|cpp|cs|css|csv|go|h|hpp|html|ini|java|js|json|jsx|log|md|mjs|py|rs|sh|sql|toml|ts|tsx|txt|xml|yaml|yml)$/iu.test(
    path,
  );
}

export function inferAttachmentMimeFromPath(path: string): string {
  const extension = path.split(".").pop()?.toLocaleLowerCase() ?? "";
  if (extension === "pdf") return "application/pdf";
  if (extension === "json") return "application/json";
  if (extension === "csv") return "text/csv";
  if (extension === "md") return "text/markdown";
  // video 扩展名映射复用 attachment-video 的唯一事实源，避免两处维护同一张表。
  const videoMime = inferVideoMimeFromPath(path);
  if (videoMime) return videoMime;
  return isTextLikePath(path) ? "text/plain" : "application/octet-stream";
}

function formatPathReferenceReason(reason: PathReferenceReason): string {
  if (reason === "deferred_topic_history") return "topic history is provided for on-demand reading";
  if (reason === "deferred_clipboard_text") {
    return "it is a pasted-text temporary attachment that is deferred to keep the model context small";
  }
  if (reason === "image_too_large") return "the image is larger than the inline media budget";
  if (reason === "pdf_too_large") return "the PDF is larger than the inline PDF input limit";
  if (reason === "text_too_large") return "the text file is larger than the inline text budget";
  if (reason === "video_too_large") return "the video is larger than the ZCode video input limit";
  return "the file is not a known text attachment";
}
