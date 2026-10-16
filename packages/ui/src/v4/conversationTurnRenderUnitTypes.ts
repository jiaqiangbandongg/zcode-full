import type { PluginUiRowPinResolver } from "@/plugin-ui/index.js";
import type { BotTopicPreparation } from "@zcode/shared";
import type {
  AssistantTextRow,
  ConversationRow,
  HookInvocationRow,
  SessionPhase,
  TimelineMarkerRow,
  TurnHeaderRow,
  UserInputRow,
  WorkflowLaunchMeta,
} from "@zcode/shared/zcode-protocol-v4";
import type { AssistantWorkRow, ConversationTurnFlowItem } from "@/v4/conversationTurnFlowItems.js";
import type {
  ConversationTurnWorkSegment,
  ConversationTurnWorkStatus,
} from "@/v4/conversationTurnWorkSegments.js";
import type { HighspeedOutputFooterMark } from "@/highspeed/highspeedOutputFooter.js";

export interface ConversationTurnRenderUnit extends HighspeedOutputFooterMark {
  /** 未接受的 Bot 消息展示投影，不写入 CLI rows 或导航/分享索引。 */
  topicPreparations?: readonly BotTopicPreparation[];
  key: string;
  turnId: string;
  header?: TurnHeaderRow;
  visibleUserInputs: UserInputRow[];
  assistantWorkRows: AssistantWorkRow[];
  /**
   * 所有 visual work segment 的历史行聚合，仅供复制、预览和旧调用兼容。
   * 实际折叠边界读取 workSegments，且各段内部必须保持 CLI row 全序。
   */
  assistantHistoryRows: AssistantWorkRow[];
  /** 操作正文锚点之后、真正轮尾 marker 之前的 row；保持 CLI 全序原位渲染。 */
  assistantFollowingRows: AssistantWorkRow[];
  assistantTailRows: AssistantWorkRow[];
  /** Browser 自动轮尾截图：完成态渲染在 file diff 摘要之后、消息操作栏之前。 */
  browserTurnEndRows: AssistantWorkRow[];
  /** turn-local Hook product rows；不进入 assistant work/折叠，只供轮尾详情 action。 */
  hookInvocations: HookInvocationRow[];
  /** S2：整轮全部 assistant text 段，用于复制/预览聚合，不代表渲染位置。 */
  assistantTextRows: AssistantTextRow[];
  /** 轻边界（modelChange，S13）：渲染在 user 输入之前的轮顶分隔。 */
  leadingBoundaryRows: TimelineMarkerRow[];
  /** 完成态轮尾最终正文；fork/retry/action/preview 只挂这一段。 */
  latestAssistantTextRow?: AssistantTextRow;
  /** 同一 product turn 内 user/assistant 的可见交错顺序；相邻工作行保持成组。 */
  flowItems: ConversationTurnFlowItem[];
  /** 原始输入与每条 accepted guide 分别对应一个独立视觉工作段。 */
  workSegments?: ConversationTurnWorkSegment[];
  renderRows: ConversationRow[];
  isLastTurn: boolean;
  isRunning: boolean;
  assistantHistoryDefaultOpen: boolean;
  timelineOnly: boolean;
  /** turn 级聚合工作状态，仅供旧调用兼容；新组件消费 workSegments[].workStatus。 */
  workStatus?: ConversationTurnWorkStatus;
  startedAt?: number;
  /** 中枢直接启动轮的启动元数据（规则见 `workflowLaunchTurn.ts`）；在场时轮由 run 卡呈现、无用户气泡。 */
  workflowLaunch?: WorkflowLaunchMeta;
}

export interface BuildConversationTurnRenderUnitsOptions {
  nowMs?: number;
  sessionPhase?: SessionPhase;
  /** 插件卡片折叠裁决（时间线由推导结果 + 手动状态组装）。 */
  pluginUiPinResolver?: PluginUiRowPinResolver;
}
