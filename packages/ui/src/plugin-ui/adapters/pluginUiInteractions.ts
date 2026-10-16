import { getPluginUiSessionActions } from "@/plugin-ui/adapters/pluginUiSessionActions.js";
import type { PluginUiHostControllerDeps } from "@/plugin-ui/app/pluginUiHostController.js";
import type { PluginUiScopeRef } from "@zcode/shared/mcp-apps";
import { buildPluginSandboxScopeId, concatMcpAppsTextContent } from "@zcode/shared/mcp-apps";
import { requestPluginUiFollowUpConfirmation } from "../app/pluginUiFollowUpDialogStore.js";
import {
  PLUGIN_UI_FOLLOW_UP_STRUCTURED_MAX_BYTES,
  buildPluginUiFollowUpPrompt,
} from "../domain/pluginUiFollowUp.js";
import { readPluginUiImageBlocks } from "../domain/pluginUiImageBlocks.js";
import { dispatchPluginUiModelContextAdd } from "./pluginUiModelContextEvents.js";

import { type PluginUiSessionScope } from "@/plugin-ui/contract.js";

export interface PluginUiInteractionScope extends PluginUiSessionScope {
  sessionId: string;
  pluginId: string;
  /** 工具卡片或面板；决定 widgetState 的 surfaceKey 以及来源标记 / 上下文 id。 */
  scope: PluginUiScopeRef;
}

const JSON_RPC_UNAVAILABLE = -32601;
const JSON_RPC_CANCELLED = -32000;

function rpcError(code: number, message: string): Error & { code: number } {
  return Object.assign(new Error(message), { code });
}

/** H11-b / S3：image 块校验失败 → -32602 unsupported_content，带上原因供页面排错。 */
function readImagesOrThrow(content: readonly Record<string, unknown>[] | undefined) {
  const images = readPluginUiImageBlocks(content);
  if (images.ok) return images.images;
  const detail =
    images.reason === "too_large"
      ? `image exceeds 4 MiB (${images.bytes} bytes)`
      : images.reason === "unsupported_mime"
        ? `unsupported image mimeType ${images.mimeType ?? "(missing)"}; use png / jpeg / webp`
        : "image block must carry base64 data and mimeType";
  throw rpcError(-32602, `unsupported_content: ${detail}`);
}

/** 来源 / 上下文标记里的作用域 id：工具卡片沿用裸 toolCallId（兼容），面板用 `surface:<id>`。 */
function scopeMarker(scope: PluginUiScopeRef): string {
  return scope.kind === "toolCall" ? scope.toolCallId : buildPluginSandboxScopeId(scope);
}

/**
 * 第二、三批宿主回调：
 * - sendFollowUpMessage：有用户手势直接以用户身份发送；无手势弹可编辑确认框，取消回 -32000。
 *   ：structuredContent 以 ```json 块拼在文本后面；来源只进 metadata `source`。
 * - updateModelContext：投递到当前会话 composer 的插件上下文块；没有 composer 接住回 -32601。
 * widgetState 由窗口页面管理器唯一写入。
 */
export function createPluginUiInteractions(
  input: PluginUiInteractionScope,
): Pick<PluginUiHostControllerDeps, "onSendFollowUpMessage" | "onUpdateModelContext"> {
  const marker = scopeMarker(input.scope);
  const source = { kind: "pluginUi" as const, pluginId: input.pluginId, toolCallId: marker };
  return {
    async onSendFollowUpMessage(payload, context) {
      const actions = getPluginUiSessionActions(input);
      if (!actions)
        throw rpcError(JSON_RPC_UNAVAILABLE, "Follow-up messages are not available here");
      // H11-a：structuredContent 拼进 prompt（```json 块），确认框里用户看到并可编辑的就是最终发送内容。
      const built = buildPluginUiFollowUpPrompt(payload.prompt, payload.structuredContent);
      if (!built.ok) {
        throw rpcError(
          -32602,
          built.reason === "empty_prompt"
            ? "prompt must not be empty"
            : `structuredContent exceeds ${PLUGIN_UI_FOLLOW_UP_STRUCTURED_MAX_BYTES} bytes (${built.bytes})`,
        );
      }
      let prompt = built.prompt;
      const images = readImagesOrThrow(payload.content);
      const gesture = await context.consumeUserGesture();
      if (!gesture) {
        const confirmed = await requestPluginUiFollowUpConfirmation({
          pluginId: input.pluginId,
          prompt,
        });
        if (confirmed === null || !confirmed.trim()) {
          throw rpcError(JSON_RPC_CANCELLED, "User cancelled the follow-up message");
        }
        prompt = confirmed.trim();
      }
      // 修复：确认弹窗等待期间可能已经切换或关闭会话，不能使用捕获的旧命令入口。
      if (getPluginUiSessionActions(input) !== actions)
        throw rpcError(JSON_RPC_UNAVAILABLE, "Session binding is no longer available");
      context.assertCurrent();
      await actions.sendFollowUp({ prompt, source, ...(images.length > 0 ? { images } : {}) });
    },
    async onUpdateModelContext(payload) {
      const text = concatMcpAppsTextContent(payload.content);
      const images = readImagesOrThrow(payload.content);
      const delivered = dispatchPluginUiModelContextAdd(input, {
        id: `plugin-ui-context:${input.pluginId}:${marker}`,
        sessionId: input.sessionId,
        pluginId: input.pluginId,
        toolCallId: marker,
        text,
        ...(payload.structuredContent !== undefined
          ? { structuredContent: payload.structuredContent }
          : {}),
        ...(images.length > 0 ? { images } : {}),
      });
      if (!delivered)
        throw rpcError(JSON_RPC_UNAVAILABLE, "No composer is listening for model context");
    },
  };
}
