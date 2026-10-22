import {
  modelMessageContentToText,
  type ModelMessageContent,
  type ModelMessageContentBlock,
} from "@zcode/contracts";
import { findOfficialCuaFrameContentPair } from "@zcode/zcode-cua/frame-contract";
import type { ToolEntry, ToolResultSerialization } from "../types.js";
import { isPersistedOutputContent } from "../result-persistence-format.js";

export interface HookStringProjection {
  content: string;
  truncated: boolean;
}

const TOOL_REFERENCE_TEXT_TRUNCATION_MARKER = "[Tool result text truncated by resultBudget]";

export function projectToolReferenceContent(
  modelContent: ModelMessageContent,
  maxTextBytes: number,
  direction: "head" | "tail",
):
  | Pick<ToolResultSerialization, "modelContent" | "content" | "returnedBytes" | "truncated">
  | undefined {
  if (
    !Array.isArray(modelContent) ||
    !modelContent.some((block) => block.type === "tool_reference") ||
    !modelContent.every((block) => block.type === "text" || block.type === "tool_reference")
  )
    return undefined;

  // 引用既是 schema 加载协议也是发现状态，不能按展示文本截断或转成 artifact。
  // 仅裁剪文本，原始引用及块顺序必须保留；展示内容和计量统一从最终块派生。
  const truncated = Buffer.byteLength(joinTextBlocks(modelContent), "utf8") > maxTextBytes;
  let projected: ModelMessageContentBlock[] = modelContent;
  if (truncated) {
    const marker = fitStringToBytes(TOOL_REFERENCE_TEXT_TRUNCATION_MARKER, maxTextBytes, "head");
    let remainingBytes = maxTextBytes - Buffer.byteLength(marker, "utf8");
    let hasText = marker.length > 0;
    const ordered = direction === "tail" ? [...modelContent].reverse() : modelContent;
    projected = ordered.flatMap((block): ModelMessageContentBlock[] => {
      if (block.type !== "text") return [block];
      const textBudget = Math.max(0, remainingBytes - (hasText ? 2 : 0));
      const text = fitStringToBytes(block.text, textBudget, direction);
      if (text.length > 0) {
        remainingBytes -= Buffer.byteLength(text, "utf8") + (hasText ? 2 : 0);
        hasText = true;
      }
      if (text.length < block.text.length) remainingBytes = 0;
      return text ? [{ ...block, text }] : [];
    });
    if (direction === "tail") projected.reverse();
    if (marker) projected.push({ type: "text", text: marker });
  }
  const content = stringifyModelContentForSerialization(projected);
  return {
    modelContent: projected,
    content,
    returnedBytes: Buffer.byteLength(content, "utf8"),
    truncated,
  };
}

export const OFFICIAL_CUA_TEXT_TRUNCATION_MARKER =
  "[Official CUA text truncated by resultBudget. Re-observe with detail=compact or a narrower window before relying on omitted state.]";

export const OFFICIAL_CUA_FRAME_CONTRACT_ERROR_CODE = "official_cua_frame_pair_not_leading";

export class OfficialCuaFrameContractError extends Error {
  readonly code = OFFICIAL_CUA_FRAME_CONTRACT_ERROR_CODE;

  constructor() {
    super("Official CUA frame pair must be the first two result blocks");
    this.name = "OfficialCuaFrameContractError";
  }
}

export function projectOfficialCuaStructuredContent(
  content: ModelMessageContentBlock[],
  maxModelBytes: number,
  direction: "head" | "tail",
): { content: ModelMessageContentBlock[]; truncated: boolean } | undefined {
  const pair = findOfficialCuaFrameContentPair(content);
  if (!pair) return undefined;
  // 官方 producer 的 canonical pair 必须已经位于结果首部。consumer 只校验、
  // 预算并保序，不再猜测或提升非 canonical 布局。这里直接失败，避免后续通用
  // 小结果直通路径重新把带前缀的 frame authority 交给模型。
  if (pair.imageIndex !== 0 || pair.imageRefIndex !== 1) {
    throw new OfficialCuaFrameContractError();
  }

  const pairContent: ModelMessageContentBlock[] = [pair.image, pair.imageRef];
  const suffixBlocks = content
    .slice(2)
    .filter(
      (block): block is Extract<ModelMessageContentBlock, { type: "text" }> =>
        block.type === "text" && block.text.length > 0,
    );
  const hasOtherStructuredBlocks = content.some(
    (block, index) =>
      index !== pair.imageRefIndex && index !== pair.imageIndex && block.type !== "text",
  );
  const completeContent: ModelMessageContentBlock[] = [...pairContent, ...suffixBlocks];
  if (
    !hasOtherStructuredBlocks &&
    Buffer.byteLength(stringifyModelContentForSerialization(completeContent), "utf8") <=
      maxModelBytes
  ) {
    return { content: completeContent, truncated: false };
  }

  const suffixText = joinTextBlocks(suffixBlocks);
  const pairBytes = Buffer.byteLength(stringifyModelContentForSerialization(pairContent), "utf8");
  const remainingAfterPair = Math.max(0, maxModelBytes - pairBytes);
  const projectedMarker = fitStringToBytes(
    OFFICIAL_CUA_TEXT_TRUNCATION_MARKER,
    Math.max(0, remainingAfterPair - 2),
    "head",
  );
  const markerCost =
    projectedMarker.length > 0 ? Buffer.byteLength(projectedMarker, "utf8") + 2 : 0;
  const suffixBudget =
    projectedMarker.length > 0 ? Math.max(0, remainingAfterPair - markerCost - 2) : 0;
  const projectedSuffix = fitStringToBytes(suffixText, suffixBudget, direction);

  const projected: ModelMessageContentBlock[] = [
    pair.image,
    pair.imageRef,
    ...(projectedSuffix ? [{ type: "text" as const, text: projectedSuffix }] : []),
    ...(projectedMarker ? [{ type: "text" as const, text: projectedMarker }] : []),
  ];
  return {
    content: projected,
    truncated: true,
  };
}

export function appendHookWithoutReorderingStructuredContent(
  serialization: ToolResultSerialization,
  hookContext: string,
  suffix: string,
  maxModelBytes: number,
): ToolResultSerialization {
  const modelContent = serialization.modelContent ?? serialization.content;
  if (!Array.isArray(modelContent)) return serialization;

  const currentBytes = Buffer.byteLength(serialization.content, "utf8");
  const remainingBytes = Math.max(0, maxModelBytes - currentBytes);
  const separator = "\n\n";
  const separatorBytes = Buffer.byteLength(separator, "utf8");
  const fittedHookContext =
    remainingBytes > separatorBytes
      ? fitStringToBytes(hookContext, remainingBytes - separatorBytes, "head")
      : "";
  const fittedSuffix = fittedHookContext.length > 0 ? `${separator}${fittedHookContext}` : "";
  const hookTruncated = Buffer.byteLength(suffix, "utf8") > remainingBytes;
  const content = `${serialization.content}${fittedSuffix}`;

  return {
    ...serialization,
    content,
    // 只能在原始块之后追加 hook。这样 raster 仍然是首块、image_ref 仍紧随其后，
    // 即使 hook 超出预算也不会把文本搬到图片前或用字符串替换图片。
    modelContent:
      fittedHookContext.length > 0
        ? [...modelContent, { type: "text", text: fittedHookContext }]
        : modelContent,
    // returnedBytes 已包含受保护 raster；追加 hook 只增加实际新增的文本 bytes，
    // 避免重新拆分文本/媒体并维护第二份计量状态。
    returnedBytes: serialization.returnedBytes + Buffer.byteLength(fittedSuffix, "utf8"),
    truncated: serialization.truncated || hookTruncated,
  };
}

export function appendHookToStringContent(
  content: string,
  suffix: string,
  maxBytes: number,
  previewDirection: "head" | "tail",
): HookStringProjection {
  const augmentedContent = `${content}${suffix}`;
  if (Buffer.byteLength(augmentedContent, "utf8") <= maxBytes) {
    return { content: augmentedContent, truncated: false };
  }
  return {
    content: fitContentWithSuffix(content, maxBytes, suffix, previewDirection),
    truncated: true,
  };
}

export function appendHookToPersistedArtifactPreview(
  content: string,
  suffix: string,
  maxHookBytes: number,
): HookStringProjection {
  const fittedSuffix = fitStringToBytes(suffix, maxHookBytes, "head");
  return {
    content: `${content}${fittedSuffix}`,
    truncated: Buffer.byteLength(suffix, "utf8") > maxHookBytes,
  };
}

export function projectHookAugmentedModelContent(input: {
  artifactPreview: boolean;
  contentProjection: HookStringProjection;
  hookContext: string;
  maxModelBytes: number;
  modelContent: ModelMessageContent;
  previewDirection: "head" | "tail";
  suffix: string;
}): ModelMessageContent {
  if (input.artifactPreview) return input.contentProjection.content;
  if (!input.contentProjection.truncated) {
    return appendHookContextToModelContent(input.modelContent, input.hookContext);
  }
  if (!hasPreservedStructuredBlocks(input.modelContent)) return input.contentProjection.content;

  const textContent = budgetedTextFromStructuredContent(input.modelContent);
  const budgetedText = fitContentWithSuffix(
    textContent,
    input.maxModelBytes,
    input.suffix,
    input.previewDirection,
  );
  return [
    ...input.modelContent.filter(shouldPreserveStructuredBlock),
    ...(budgetedText.length > 0 ? [{ type: "text" as const, text: budgetedText }] : []),
  ];
}

export function fitContentWithSuffix(
  content: string,
  maxBytes: number,
  suffix: string,
  direction: "head" | "tail",
): string {
  if (maxBytes <= 0) return "";
  const suffixContent = fitStringToBytes(suffix, maxBytes, "head");
  const remainingBytes = maxBytes - Buffer.byteLength(suffixContent, "utf8");
  if (remainingBytes <= 0) return suffixContent;
  return `${fitStringToBytes(content, remainingBytes, direction)}${suffixContent}`;
}

function joinTextBlocks(content: ModelMessageContentBlock[]): string {
  return content
    .filter(
      (block): block is Extract<ModelMessageContentBlock, { type: "text" }> =>
        block.type === "text",
    )
    .map((block) => block.text)
    .filter((text) => text.length > 0)
    .join("\n\n");
}

export function stringifyModelContentForSerialization(content: ModelMessageContent): string {
  return typeof content === "string" ? content : modelMessageContentToText(content);
}

export function isEmptyModelContent(content: ModelMessageContent): boolean {
  if (typeof content === "string") return content.trim() === "";
  if (content.length === 0) return true;
  return content.every((block) => {
    if (block.type !== "text") return false;
    return typeof block.text !== "string" || block.text.trim() === "";
  });
}

export function stringifyOutputForModel(output: unknown, entry: ToolEntry): ModelMessageContent {
  if (entry.formatModelContent) return entry.formatModelContent(output);
  if (typeof output === "string") return output;
  if (output === undefined) return "";

  try {
    return JSON.stringify(output) ?? "";
  } catch {
    return String(output);
  }
}

export function isPersistedArtifactPreview(serialization: ToolResultSerialization): boolean {
  return (
    serialization.budgetStrategy === "artifact" &&
    serialization.truncated &&
    typeof serialization.artifactPath === "string" &&
    serialization.artifactPath.length > 0 &&
    isPersistedOutputContent(serialization.content)
  );
}

function appendHookContextToModelContent(
  content: ModelMessageContent,
  hookContext: string,
): ModelMessageContent {
  if (typeof content === "string") return `${content}\n\n${hookContext}`;
  return [...content, { type: "text", text: hookContext }];
}

function hasPreservedStructuredBlocks(
  content: ModelMessageContent,
): content is ModelMessageContentBlock[] {
  return Array.isArray(content) && content.some(shouldPreserveStructuredBlock);
}

function shouldPreserveStructuredBlock(block: ModelMessageContentBlock): boolean {
  if (block.type === "text") return false;
  if (block.type === "file" && typeof block.text === "string" && block.text.length > 0) {
    return false;
  }
  return true;
}

function budgetedTextFromStructuredContent(content: ModelMessageContentBlock[]): string {
  return content
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "file" && typeof block.text === "string") return block.text;
      return "";
    })
    .filter((text) => text.length > 0)
    .join("\n\n");
}

function fitStringToBytes(value: string, maxBytes: number, direction: "head" | "tail"): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;

  const chars = Array.from(value);
  let low = 0;
  let high = chars.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate =
      direction === "tail"
        ? chars.slice(chars.length - mid).join("")
        : chars.slice(0, mid).join("");
    if (Buffer.byteLength(candidate, "utf8") <= maxBytes) low = mid;
    else high = mid - 1;
  }
  return direction === "tail"
    ? chars.slice(chars.length - low).join("")
    : chars.slice(0, low).join("");
}
