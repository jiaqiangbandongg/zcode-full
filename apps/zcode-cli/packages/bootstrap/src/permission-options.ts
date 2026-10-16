import type { PermissionOptionsPolicy, PermissionUpdate } from "@zcode/contracts";
import { OFFICIAL_CUA_PERMISSION_RULE_TOOL_NAME, type ZCodePermissionOption } from "@zcode/shared";

const PROJECT_RULE_INPUT_KEYS = ["command", "url", "file_path", "path", "pattern"] as const;

// 普通交互 permission 的用户拒绝需要明确告知模型工具未执行，
// 并等待用户后续指示；该 reason 同时作为 provider-visible tool_result.content。
export const PERMISSION_DENIED_BY_USER_CONTENT =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";

export function buildPermissionDeniedContent(feedback?: string): string {
  const trimmed = feedback?.trim();
  return trimmed
    ? `${PERMISSION_DENIED_BY_USER_CONTENT} To tell you how to proceed, the user said:\n${trimmed}`
    : PERMISSION_DENIED_BY_USER_CONTENT;
}

/**
 * 会话授权选项的标识、内部种类与显示名称。
 * optionId 上 v4 wire 原样传递（broker 靠它精确命中）；kind 是 CLI 内部值，v4 投影把它映到
 * 闭集里的 `allowAlways`；name 是 GUI 本地化的匹配键（PermissionDialog 的全局 name 映射表）。
 */
const SESSION_ALLOW_PERMISSION_OPTION_ID = "allowSession";
export const SESSION_ALLOW_PERMISSION_OPTION_KIND = "allow_session";
const SESSION_ALLOW_PERMISSION_OPTION_NAME = "Always allow in this session";

interface PermissionOptionSource {
  approvalMode?: "user-once";
  input?: unknown;
  suggestedPermissionUpdates?: PermissionUpdate[];
  optionsPolicy?: PermissionOptionsPolicy;
  toolName: string;
}

/**
 * v3 与 v4 共用的纯权限选项投影。放在协议目录之外，避免 v4 权威投影反向依赖旧协议。
 */
export function buildProtocolPermissionOptions(
  source: PermissionOptionSource,
): ZCodePermissionOption[] {
  const permissionUpdates = source.suggestedPermissionUpdates?.length
    ? source.suggestedPermissionUpdates
    : defaultPermissionUpdates(source);
  const officialCuaProjectScope = permissionUpdates.some((update) =>
    update.rules.some((rule) => rule.toolName === OFFICIAL_CUA_PERMISSION_RULE_TOOL_NAME),
  );
  const options: ZCodePermissionOption[] = [
    {
      kind: "allow_once",
      name: "Allow once",
      optionId: "allow_once",
      response: {
        decision: "allow",
        reason: "Approved once",
      },
    },
    // 工具可以声明 no-always-allow：每次调用都是不同代码时，持久规则不是"记住这次决定"，
    // 而是把这道确认永久关掉。session-always-allow 则换成会话作用域的免确认：response 里
    // **没有** permissionUpdates——wire 上 zcodePermissionUpdateSchema 是 strict，会话语义由
    // broker 在应答侧合成为 sessionPermissionUpdates（纯内存，绝不落项目规则）。
    ...(source.optionsPolicy === "no-always-allow"
      ? []
      : source.optionsPolicy === "session-always-allow"
        ? [
            {
              description: "Do not ask again for this tool in this session",
              kind: SESSION_ALLOW_PERMISSION_OPTION_KIND,
              name: SESSION_ALLOW_PERMISSION_OPTION_NAME,
              optionId: SESSION_ALLOW_PERMISSION_OPTION_ID,
              response: {
                decision: "allow" as const,
                reason: "Approved for this session",
              },
            },
          ]
        : [
            {
              description: officialCuaProjectScope
                ? "Do not ask again for official Computer Use tools in this project"
                : "Do not ask again for matching requests in this project",
              kind: "allow_always" as const,
              name: officialCuaProjectScope
                ? "Always allow Computer Use in this project"
                : "Always allow in this project",
              optionId: "allow_project",
              response: {
                decision: "allow" as const,
                permissionUpdates,
                reason: "Approved for this project",
              },
            },
          ]),
    {
      kind: "deny",
      name: "Deny",
      optionId: "deny",
      response: {
        decision: "deny",
        reason: PERMISSION_DENIED_BY_USER_CONTENT,
      },
    },
  ];
  return source.approvalMode === "user-once"
    ? options.filter((option) => option.kind === "allow_once" || option.kind === "deny")
    : options;
}

/**
 * 会话授权按工具整体授予（无 ruleContent）：脚本每次都不同，授权的是「这个工具」而不是某段脚本。
 */
export function buildSessionPermissionUpdates(toolName: string): PermissionUpdate[] {
  return [{ behavior: "allow", rules: [{ toolName }], type: "addRules" }];
}

/**
 * legacy v3（session-mapper、broker 的 v3 反向 RPC）认不出会话语义：旧桌面回传的是 option
 * response 原文，投放会话选项只会得到一个名不副实的「一次允许」。所以两种策略在 legacy 上
 * 都只表现为「裁掉 always allow」。
 */
export function toLegacyPermissionOptionsPolicy(policy: unknown): "no-always-allow" | undefined {
  switch (policy) {
    case "no-always-allow":
    case "session-always-allow":
      return "no-always-allow";
    default:
      return undefined;
  }
}

function defaultPermissionUpdates(source: PermissionOptionSource): PermissionUpdate[] {
  const ruleContent = ruleContentFromPermissionInput(source.input);
  return [
    {
      behavior: "allow",
      rules: [
        {
          toolName: source.toolName,
          ...(ruleContent ? { ruleContent } : {}),
        },
      ],
      type: "addRules",
    },
  ];
}

function ruleContentFromPermissionInput(input: unknown): string | undefined {
  if (typeof input === "string" && input.trim().length > 0) {
    return input;
  }

  const record = asRecord(input);
  for (const key of PROJECT_RULE_INPUT_KEYS) {
    const value = stringField(record, key);
    if (value) {
      return value;
    }
  }

  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
