// ============================================================
// Permission Broker Port - async client permission boundary
// ============================================================

import type { PermissionDecision } from "../events/session.events.js";
import type { ModelToolSideEffectScope } from "../model/index.js";
import type { CollaborationMode, RiskLevel } from "./session.port.js";
import type { InteractionRequestOrigin, SessionId, ToolCallId, TraceId, TurnId } from "./shared.js";

export type PermissionRuleBehavior = "allow" | "deny" | "ask";

export const PermissionCapabilityGroup = {
  OfficialCua: "official_cua",
} as const;

export type PermissionCapabilityGroup =
  (typeof PermissionCapabilityGroup)[keyof typeof PermissionCapabilityGroup];

export interface PermissionRuleValue {
  toolName: string;
  ruleContent?: string;
}

export interface PermissionRuleset {
  /** 群协作任务的记忆授权仅在当前 session 内生效。 */
  scope?: "session";
  version?: 1;
  allow?: PermissionRuleValue[];
  deny?: PermissionRuleValue[];
  ask?: PermissionRuleValue[];
  mode?: CollaborationMode;
  [key: string]: unknown;
}

export type PermissionUpdate = {
  type: "addRules";
  behavior: PermissionRuleBehavior;
  rules: PermissionRuleValue[];
};

// 修改原因：workflow Refine 与 plan 反馈同构——
// deny + reason 只有携带专用 source 才允许被升级为真实 user message。
export type PermissionBrokerReasonSource = "plan_approval_feedback" | "workflow_refine_feedback";

/**
 * Narrows the option set a permission ask may offer. `no-always-allow` drops the
 * persistent project rule option: some tools carry different code on every call
 * (CreateWorkflow scripts), so "always allow" would permanently disable the gate
 * rather than remember a comparable decision. `session-always-allow` replaces the
 * persistent rule with a session-scoped one that lives only in the runtime's memory.
 */
export type PermissionOptionsPolicy = "no-always-allow" | "session-always-allow";

export interface PermissionBrokerRequest {
  approvalMode?: "user-once";
  requestId: string;
  sessionId: SessionId;
  turnId?: TurnId;
  traceId: TraceId;
  toolCallId: ToolCallId;
  toolName: string;
  input: unknown;
  mode: CollaborationMode;
  ruleId: string;
  reason: string;
  riskLevel: RiskLevel;
  sideEffectScope?: ModelToolSideEffectScope;
  suggestedPermissionUpdates?: PermissionUpdate[];
  optionsPolicy?: PermissionOptionsPolicy;
  requestedAt: Date;
  origin?: InteractionRequestOrigin;
}

export interface PermissionBrokerResult {
  decision: PermissionDecision;
  reason?: string;
  /** V4 permission feedback 需要保留 provider-visible 原文；只由 broker 结果携带。 */
  preserveReasonFormatting?: boolean;
  reasonSource?: PermissionBrokerReasonSource;
  modifiedInput?: unknown;
  permissionUpdates?: PermissionUpdate[];
  /**
   * Session-scoped grants ("Always allow in this session"). Applied to the runtime's
   * in-memory session ruleset only; never persisted with `permissionUpdates`. Synthesized
   * by the broker on the answer side because the wire option schema is strict.
   */
  sessionPermissionUpdates?: PermissionUpdate[];
  /**
   * Fields the user changed in the confirmation window before approving, keyed by the tool's own
   * input field names; `null` means "back to the field's default". Carried only on an allow and
   * applied only by a tool that declares `applyInputAdjustments` (CreateWorkflow and
   * AmendWorkflow: docs/dynamic-workflow/launch.md「Adjusting the settings in the window」).
   * Synthesized by the broker from the v4 answer's `content`.
   */
  inputAdjustments?: Readonly<Record<string, unknown>>;
  resolvedAt?: Date;
}

export interface PermissionBrokerRequestOptions {
  /** 带提交副作用的应答先取得唯一胜者；失败保留用户审批，Hook 不再竞争。 */
  claimResponse?: () => boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface PermissionBrokerPort {
  requestPermission(
    request: PermissionBrokerRequest,
    options?: PermissionBrokerRequestOptions,
  ): Promise<PermissionBrokerResult> & {
    /** 异步登记时必须提供；缺省表示调用内同步登记。仅表示可响应，不持有授权状态。 */
    readonly registered?: Promise<void>;
  };
}
