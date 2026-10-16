import type { MessageSemantics, MessageVisibility, SyntheticUserMessageSource } from "../deps.js";
import { runtimeMetadataForSyntheticUserMessageSource } from "../helpers/index.js";

export function buildSyntheticUserNoticePartMetadata(
  source: SyntheticUserMessageSource,
  visibility: MessageVisibility,
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return {
    ...metadata,
    runtimeMessage:
      metadata?.runtimeMessage ?? runtimeMetadataForSyntheticUserMessageSource(source),
    source,
    visibility,
  };
}

export function buildSyntheticUserNoticeMessageMetadata(
  source: SyntheticUserMessageSource,
  visibility: MessageVisibility,
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const next = { ...metadata };
  delete next.runtimeMessage;
  return {
    ...next,
    source,
    visibility,
  };
}

export function buildSyntheticUserNoticeSemantics(
  source: SyntheticUserMessageSource,
  visibility: MessageVisibility,
): MessageSemantics {
  if (source === "shared_context") {
    return {
      origin: "import",
      kind: "shared_context",
      source,
      uiVisibility: "hidden",
      providerVisibility: "visible",
      transcriptVisibility: "visible",
    };
  }
  const providerVisible = visibility === "model-only";
  return {
    origin: "agent_runtime",
    kind: syntheticUserNoticeKind(source),
    source,
    uiVisibility: providerVisible ? "hidden" : "visible",
    providerVisibility: providerVisible ? "visible" : "hidden",
    // provider-visible 的 user-role runtime context 不是用户 transcript。
    // fork/goal/background 等 synthetic notice 如果标成 transcript visible，
    // v4 hydration 会把它们误当作真实用户 turn。
    transcriptVisibility: providerVisible ? "hidden" : "visible",
  };
}

function syntheticUserNoticeKind(source: SyntheticUserMessageSource): MessageSemantics["kind"] {
  switch (source) {
    case "background_task":
      return "background_notification";
    case "fork":
      return "fork_notice";
    // goal_state_change 是 trajectory 分支新增的 runtime 注入源（target.ts 目标变更通知），
    // 与 goal-continuation 同属 system reminder 语义。
    case "goal_state_change":
      return "system_reminder";
    case "goal-continuation":
      return "system_reminder";
    case "agent_listing_delta":
    case "plugin_reference":
    case "bot_topic_context":
      return "system_reminder";
    case "rewind":
      return "rewind_notice";
    case "selection_side_chat":
      return "system_reminder";
    case "subagent":
      return "subagent_notification";
    case "subagent_message":
      // child -> parent 的 model-only runtime carrier，
      // 若这里未同步穷举，持久消息会产生 kind=undefined，冷恢复后无法保持语义等价。
      return "subagent_notification";
    case "todo_reminder":
      return "todo_reminder";
    // 直接启动的启动轮不走这条 synthetic-notice 铸造路（它要 origin=real_user、kind=user_prompt，
    // 由 message-persistence 的专用落盘直接给出）。这里只为穷举完备而登记同一个 kind。
    case "workflow_launch":
      return "user_prompt";
    case "shared_context":
      return "shared_context";
  }
}
