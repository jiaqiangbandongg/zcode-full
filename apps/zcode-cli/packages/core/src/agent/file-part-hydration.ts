import type {
  AttachmentRef,
  FilePart,
  ModelMessageContentBlock,
  ToolArtifactStorePort,
} from "@zcode/contracts";

export async function filePartToContentBlock(
  part: FilePart,
  artifactStore: ToolArtifactStorePort | undefined,
): Promise<ModelMessageContentBlock> {
  const pathReferenceText = part.metadata?.pathReferenceText;
  if (part.metadata?.storageKind === "local_ref" && typeof pathReferenceText === "string") {
    // 这是已发给模型的说明，不是文件内容；直接恢复原文，不重新读取或推测降级原因。
    return { type: "text", text: pathReferenceText };
  }
  const source = attachmentRefFromFilePart(part);
  const dataUrl = await filePartDataUrl(part, artifactStore);
  if (isImageMime(part.mime) && dataUrl) {
    return {
      type: "image",
      mediaType: concreteMediaType(part.mime, dataUrl),
      dataUrl,
      source,
    };
  }

  if (part.mime.startsWith("video/") && dataUrl) {
    return {
      type: "video",
      mediaType: part.mime,
      dataUrl,
      source,
    };
  }

  // 增加 video 时曾把原有 PDF allowlist 泛化为所有非文本 MIME，
  // 导致 audio 等未支持类型在冷恢复后意外变成 provider file 输入。
  if (isPdfMime(part.mime) && dataUrl) {
    return {
      type: "file",
      mediaType: "application/pdf",
      name: part.filename,
      dataUrl,
      source,
    };
  }

  const previewText = part.metadata?.preview?.text;
  if (part.mime.startsWith("text/") && typeof previewText === "string") {
    return { type: "text", text: previewText };
  }

  const label =
    part.metadata?.storageKind === "local_ref"
      ? (part.source?.text.value ??
        (part.source?.type === "file" || part.source?.type === "symbol"
          ? part.source.path
          : undefined) ??
        part.metadata.originalUrl ??
        part.url)
      : (part.filename ?? part.url);
  return { type: "text", text: `[Attached ${part.mime}: ${label}]` };
}

type PersistedToolMediaLayoutEntry =
  | { type: "attachment"; attachmentIndex: number }
  | { type: "text"; text: string };

export function projectPersistedToolMediaContent(
  value: unknown,
  attachmentBlocks: ModelMessageContentBlock[],
): ModelMessageContentBlock[] | undefined {
  const layout = parsePersistedToolMediaLayout(value);
  if (!layout) return undefined;
  const content: ModelMessageContentBlock[] = [];
  for (const entry of layout) {
    if (entry.type === "text") {
      content.push({ type: "text", text: entry.text });
      continue;
    }
    const block = attachmentBlocks[entry.attachmentIndex];
    if (!block) return undefined;
    content.push(block);
  }
  return content;
}

function parsePersistedToolMediaLayout(
  value: unknown,
): PersistedToolMediaLayoutEntry[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const layout: PersistedToolMediaLayoutEntry[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return undefined;
    if (entry.type === "text" && typeof entry.text === "string") {
      layout.push({ type: "text", text: entry.text });
      continue;
    }
    if (
      entry.type === "attachment" &&
      typeof entry.attachmentIndex === "number" &&
      Number.isInteger(entry.attachmentIndex) &&
      entry.attachmentIndex >= 0
    ) {
      layout.push({ type: "attachment", attachmentIndex: entry.attachmentIndex });
      continue;
    }
    return undefined;
  }
  return layout;
}

async function filePartDataUrl(
  part: FilePart,
  artifactStore: ToolArtifactStorePort | undefined,
): Promise<string | undefined> {
  if (isUsableDataUrl(part.url)) return part.url;
  const artifactUri = durableArtifactUriFromFilePart(part);
  if (!artifactStore || !artifactUri) return undefined;
  try {
    const artifact = await artifactStore.readToolResultArtifact({ uri: artifactUri });
    return isUsableDataUrl(artifact.content) ? artifact.content : undefined;
  } catch {
    return undefined;
  }
}

function attachmentRefFromFilePart(part: FilePart): AttachmentRef {
  const artifactUri =
    (part.source?.type === "file" || part.source?.type === "symbol") &&
    (isImageMime(part.mime) || part.mime.startsWith("video/") || isPdfMime(part.mime))
      ? durableArtifactUriFromFilePart(part)
      : undefined;
  return {
    id: part.id,
    // 冷恢复的正文来自 durable artifact，若仍把持久化的原始 path 当作
    // 当前请求路径，原文件删除或修改后会让 base64 与 source path 指向不同内容；
    // image/video 有 artifact 时统一按 inline 恢复，由请求投影从同一 artifact 重建 path。
    kind: artifactUri
      ? "inline"
      : part.source?.type === "resource"
        ? "resource"
        : part.source
          ? "local_file"
          : "inline",
    uri: artifactUri ?? (part.source?.type === "resource" ? part.source.uri : part.url),
    path:
      !artifactUri && (part.source?.type === "file" || part.source?.type === "symbol")
        ? part.source.path
        : undefined,
    mimeType: part.mime,
    sizeBytes: part.metadata?.sizeBytes,
    sha256: part.metadata?.sha256,
    placeholder: part.source?.text.value ?? part.filename,
  };
}

function durableArtifactUriFromFilePart(part: FilePart): string | undefined {
  const artifactUri = part.metadata?.artifactUri ?? part.url;
  return artifactUri.startsWith("zcode-artifact://") ? artifactUri : undefined;
}

function isImageMime(mime: string): boolean {
  return mime === "image/*" || mime.startsWith("image/");
}

function isPdfMime(mime: string): boolean {
  return mime.split(";", 1)[0]?.trim().toLowerCase() === "application/pdf";
}

function isUsableDataUrl(value: string): boolean {
  const commaIndex = value.indexOf(",");
  return value.startsWith("data:") && commaIndex >= 0 && value.slice(commaIndex + 1).length > 0;
}

function concreteMediaType(mime: string, dataUrl: string): string {
  if (mime !== "image/*") return mime;
  const match = /^data:([^;,]+)(?:;base64)?,/i.exec(dataUrl);
  return match?.[1]?.toLowerCase() ?? "image/png";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
