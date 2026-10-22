import type { ModelMessage as AiSdkModelMessage } from "ai";
import {
  getUnsupportedModelInputMediaKind,
  modelMessageContentToText,
  type ModelInputFormat,
  type ModelMessageContent,
  type ModelMessageContentBlock,
} from "@zcode/contracts";
import { containsOfficialCuaImageRefCredentialText } from "@zcode/zcode-cua/frame-contract";
import { dataUrlToDataContent, unsupportedInputMediaText } from "./media-transform-policy.js";

type AiSdkUserContent = Extract<AiSdkModelMessage, { role: "user" }>["content"];
type AiSdkUserContentParts = Extract<AiSdkUserContent, unknown[]>;

interface ToolResultMediaProjectionOptions {
  apiFormat?: string;
  providerKind?: "openai" | "anthropic" | "openai-compatible" | "gateway" | "custom";
  stripMedia?: boolean;
  inputFormat?: ModelInputFormat;
  toolName: string;
}

const CHAT_STYLE_TOOL_RESULT_PROVIDER_KINDS = new Set(["openai-compatible", "gateway"]);
const TOOL_RESULT_MEDIA_INTRO_PREFIX = "Tool result media from";

export function shouldTextifyStructuredToolResults(
  options: Pick<ToolResultMediaProjectionOptions, "apiFormat" | "providerKind">,
): boolean {
  if (options.apiFormat !== undefined) {
    return options.apiFormat === "openai-chat-completions";
  }
  // 根因：openai kind 使用 Responses API；按宽泛的 OpenAI-like 家族判断会把它
  // 误投影成 Chat Completions 的 tool text + synthetic user。缺少显式格式时只对
  // 确实使用 Chat 风格结果的 provider 回退，显式 apiFormat 仍拥有最高优先级。
  return (
    options.providerKind !== undefined &&
    CHAT_STYLE_TOOL_RESULT_PROVIDER_KINDS.has(options.providerKind)
  );
}

/**
 * tool result 是否含 video 媒体。AI SDK tool result part 没有 video 变体（image-data 之外
 * 只支持 file-data/pdf），所以含 video 的 tool result 在所有 provider kind（含 anthropic）
 * 都必须走 textify + 后置 user part 投影，否则视频内容会在 wire 边界丢失。
 */
export function toolResultHasVideoMedia(content: ModelMessageContent): boolean {
  if (typeof content === "string") return false;
  return content.some((block) => block.type === "video");
}

/**
 * 配对规则（producer 谓词驱动）：紧邻 media 块之后、且内容是受保护媒体
 * 凭证（producer 签发的 image_ref 等）的 text 块，视为该 media 的配对文本。
 * provider 投影把 media 延后为独立 user 消息时（openai-like textify），配对
 * 文本必须一起延后且保持顺序——留在 tool 文本里会让模型看到"引用文本"与
 * "被引用媒体"分属两条消息，多帧场景极易配错。
 * 普通文本（说明、总结）不是凭证，不参与配对——通用工具的媒体语义保持
 * 不变；凭证判定是 producer 帧契约的一部分，宿主经 frame-contract 引用。
 * Producer canonical order is image-first（raster 在前、image_ref 紧随其后）。
 * 配对查找从 image 向后读取其 authority，不依赖 provider 特殊截断行为。
 */
type PairedTextOptions = Pick<ToolResultMediaProjectionOptions, "stripMedia" | "inputFormat">;

function isPairedTextBlock(
  content: ModelMessageContentBlock[],
  index: number,
  options: PairedTextOptions,
): boolean {
  const block = content[index];
  if (block?.type !== "text" || block.text.trim().length === 0) return false;
  // 只有 producer 签发的媒体凭证才配对；任意相邻文本配对会改变所有工具的
  // 通用媒体语义（普通截图/文件预览的相邻说明不属于媒体）。
  if (!containsOfficialCuaImageRefCredentialText(block.text)) return false;
  // 跳过空白 text 寻找更早图片会破坏 producer 规定的 image -> image_ref
  // 直接邻接关系，并可能把已被插入块拆开的 frame_ref 重新授权。
  const candidate = content[index - 1];
  return (
    candidate !== undefined &&
    contentBlockToUserMediaParts(candidate, {
      ...options,
      toolName: "",
    }).length > 0
  );
}

function pairedTextIndexes(
  content: ModelMessageContentBlock[],
  options: PairedTextOptions,
): Set<number> {
  // stripMedia 时 media 不会延后（toToolResultMediaUserParts 直接返回空），
  // 配对省略不得先行——否则文本从 tool 输出消失又不出现在任何消息里。
  if (options.stripMedia === true) return new Set();
  const paired = new Set<number>();
  for (let index = 0; index < content.length; index += 1) {
    if (isPairedTextBlock(content, index, options)) paired.add(index);
  }
  return paired;
}

export function toStructuredToolResultText(
  content: ModelMessageContent,
  options: Pick<ToolResultMediaProjectionOptions, "inputFormat"> = {},
): string {
  if (typeof content === "string") return content;
  const paired = pairedTextIndexes(content, options);
  return modelMessageContentToText(
    content.map((block, index) => {
      // 配对文本随 media 一起延后（见 toToolResultMediaUserParts），这里省略
      // 以免模型在同一次请求里看到两份引用文本。
      if (paired.has(index)) return { type: "text", text: "" };
      const unsupportedText = unsupportedInputMediaText(block, options.inputFormat);
      return unsupportedText ? { type: "text", text: unsupportedText } : block;
    }),
  );
}

export function toToolResultMediaUserParts(
  content: ModelMessageContent,
  options: ToolResultMediaProjectionOptions,
): AiSdkUserContentParts {
  if (typeof content === "string" || options.stripMedia) return [];
  const blocks = content;
  const paired = pairedTextIndexes(blocks, options);

  const parts: AiSdkUserContentParts = [
    {
      type: "text",
      text: `${TOOL_RESULT_MEDIA_INTRO_PREFIX} ${options.toolName}:`,
    },
  ];
  // 分隔符只用于隔开"连续两段配对文本"。原判据是 parts.length > 1，隐含假设配对
  // 文本总是第一个入队（旧的 text-first 布局）；producer 改成 image-first 后 raster
  // 先入队，该判据会在 image 与它的 image_ref 之间插入一个多余的空文本块。
  let lastPushedWasPairedText = false;
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]!;
    if (block.type === "text" && paired.has(index)) {
      // 配对文本与相邻 media 一起进入延后消息，保持原顺序。
      if (lastPushedWasPairedText) parts.push({ type: "text", text: "\n\n" });
      parts.push({ type: "text", text: block.text });
      lastPushedWasPairedText = true;
      continue;
    }
    const mediaParts = contentBlockToUserMediaParts(block, options);
    if (mediaParts.length === 0) continue;
    parts.push(...mediaParts);
    lastPushedWasPairedText = false;
  }
  return parts.length > 1 ? parts : [];
}

function contentBlockToUserMediaParts(
  block: ModelMessageContentBlock,
  options: ToolResultMediaProjectionOptions,
): AiSdkUserContentParts {
  switch (block.type) {
    case "image": {
      if (options.inputFormat && getUnsupportedModelInputMediaKind(block, options.inputFormat)) {
        return [];
      }
      const data = dataUrlToDataContent(block.dataUrl);
      if (!data) return [];
      return [{ type: "image", image: data.data, mediaType: block.mediaType }];
    }

    case "video": {
      if (options.inputFormat && getUnsupportedModelInputMediaKind(block, options.inputFormat)) {
        return [];
      }
      const data = dataUrlToDataContent(block.dataUrl);
      if (!data) return [];
      // 与 user 消息侧一致：video/* file part 交给 patch 后的 provider 包转 video_url / video block。
      return [{ type: "file", data: data.data, mediaType: block.mediaType }];
    }

    case "file": {
      if (block.text !== undefined && block.text.length > 0) return [];
      if (options.inputFormat && getUnsupportedModelInputMediaKind(block, options.inputFormat)) {
        return [];
      }
      const data = block.dataUrl ? dataUrlToDataContent(block.dataUrl) : undefined;
      if (!data) return [];
      return [
        {
          type: "file",
          data: data.data,
          filename: block.name,
          mediaType: block.mediaType,
        },
      ];
    }

    case "text":
    case "reasoning":
    case "tool_reference":
    case "resource_link":
      return [];
  }
}

/**
 * 通用 fail-closed 守卫（坐标帧引用不得以"引用在、栅格不在"到达模型）：
 * 结构化 tool result 携带帧引用文本（如 CUA image_ref 的精确 JSON），而其媒体
 * 因模型不支持（或 stripMedia）无法投递时，该结果必须整体错误化——占位符替换
 * 会留下 actionable 引用，诱导模型对未见过画面的坐标产生动作。规则只依赖
 * "引用文本 + 不可投递媒体"的结构组合，不感知具体工具。
 */
export function undeliverableFrameReferenceText(
  content: ModelMessageContent,
  options: Pick<ToolResultMediaProjectionOptions, "stripMedia" | "inputFormat">,
): string | undefined {
  if (!Array.isArray(content)) return undefined;
  // 与 MCP 归一化/hook 同一个内嵌扫描 detector——把 image_ref 包进说明文字
  // 不能绕过 fail-closed（安全边界不依赖 payload 形状）。
  const frameReferenceIndexes = content.flatMap((block, index) =>
    block.type === "text" && containsOfficialCuaImageRefCredentialText(block.text) ? [index] : [],
  );
  if (frameReferenceIndexes.length === 0) return undefined;
  const unavailable =
    "This tool returned a coordinate frame reference without a deliverable raster. " +
    "No image_ref or raster was exposed; do not use frame-bound coordinates. " +
    "Switch to an image-capable model and capture a new raster first.";
  if (options.stripMedia === true) return unavailable;
  // 每个凭证都必须由它直接前面的 raster 独立满足可投递性；结果中其他无关图片
  // 不能替 orphan ref 背书。
  return frameReferenceIndexes.every((index) => isPairedTextBlock(content, index, options))
    ? undefined
    : unavailable;
}
