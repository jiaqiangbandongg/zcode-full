import type { Locale } from "@zcode/shared";
import type { McpAppsResourcePermission } from "@zcode/shared/mcp-apps";
import { PLUGIN_SANDBOX_SCHEME } from "./contract.js";

/**
 * 页面浏览器权限的纯规则：Electron 权限名 → 规范四键、放行裁决、确认框文案。零 IO，Electron 接线在
 * permissionGate / session。camera / microphone / geolocation 需要用户确认；clipboardWrite 按声明放行。
 */
export type PluginSandboxPromptedPermission = Exclude<McpAppsResourcePermission, "clipboardWrite">;
export type PluginSandboxPermissionDecision = "allow" | "deny" | "prompt";

const PROMPTED: ReadonlySet<McpAppsResourcePermission> = new Set([
  "camera",
  "microphone",
  "geolocation",
]);
const PLUGIN_HOST_PREFIX = "plugin-";

/**
 * request handler 的 Electron 权限名 → 需要的规范权限；返回 null 表示不属于四键（一律拒绝）。
 * `media` 同时要音视频时两个都要求；mediaTypes 缺省按两者都要（Chromium 未给类型时保守）。
 */
export function resolvePluginSandboxRequestedPermissions(
  permission: string,
  details: { mediaTypes?: readonly string[] } | undefined,
): McpAppsResourcePermission[] | null {
  if (permission === "geolocation") return ["geolocation"];
  if (permission === "clipboard-sanitized-write" || permission === "clipboard-write") {
    return ["clipboardWrite"];
  }
  if (permission !== "media") return null;
  const types = details?.mediaTypes?.length ? details.mediaTypes : ["video", "audio"];
  const result: McpAppsResourcePermission[] = [];
  if (types.includes("video")) result.push("camera");
  if (types.includes("audio")) result.push("microphone");
  return result.length > 0 ? result : null;
}

/** check handler（同步查询，如 permissions.query）的权限名 + mediaType → 规范权限。 */
export function resolvePluginSandboxCheckedPermission(
  permission: string,
  details: { mediaType?: string } | undefined,
): McpAppsResourcePermission | null {
  if (permission === "media") {
    if (details?.mediaType === "video") return "camera";
    if (details?.mediaType === "audio") return "microphone";
    return null;
  }
  return resolvePluginSandboxRequestedPermissions(permission, undefined)?.[0] ?? null;
}

export function decidePluginSandboxPermission(input: {
  requested: readonly McpAppsResourcePermission[];
  declared: readonly McpAppsResourcePermission[];
  consented: ReadonlySet<McpAppsResourcePermission>;
}): { decision: PluginSandboxPermissionDecision; pending: PluginSandboxPromptedPermission[] } {
  if (input.requested.length === 0) return { decision: "deny", pending: [] };
  if (input.requested.some((permission) => !input.declared.includes(permission))) {
    return { decision: "deny", pending: [] };
  }
  const pending = input.requested.filter(
    (permission): permission is PluginSandboxPromptedPermission =>
      PROMPTED.has(permission) && !input.consented.has(permission),
  );
  return pending.length > 0 ? { decision: "prompt", pending } : { decision: "allow", pending: [] };
}

/** 同步查询只报已经能直接放行的：剪贴板写入按声明，其余要已同意。 */
export function isPluginSandboxPermissionGranted(input: {
  permission: McpAppsResourcePermission;
  declared: readonly McpAppsResourcePermission[];
  consented: ReadonlySet<McpAppsResourcePermission>;
}): boolean {
  if (!input.declared.includes(input.permission)) return false;
  return !PROMPTED.has(input.permission) || input.consented.has(input.permission);
}

/** 发起请求的 frame URL 必须是 `zcode-sandbox://plugin-<sandboxId>`；shell 或其他来源返回 null（拒绝）。 */
export function readPluginSandboxIdFromPluginUrl(url: string | undefined): string | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${PLUGIN_SANDBOX_SCHEME}:`) return null;
  if (!parsed.hostname.startsWith(PLUGIN_HOST_PREFIX)) return null;
  const sandboxId = parsed.pathname.startsWith("/instance/")
    ? (parsed.pathname.split("/")[2] ?? "")
    : "";
  return sandboxId.length > 0 ? sandboxId : null;
}

export interface PluginSandboxPermissionDialogText {
  title: string;
  message: string;
  detail: string;
  allowButton: string;
  denyButton: string;
}

const PERMISSION_LABELS: Record<"zh" | "en", Record<PluginSandboxPromptedPermission, string>> = {
  zh: { camera: "摄像头", microphone: "麦克风", geolocation: "位置" },
  en: { camera: "camera", microphone: "microphone", geolocation: "location" },
};

export function formatPluginSandboxPermissionDialogText(
  input: { serverName: string; permissions: readonly PluginSandboxPromptedPermission[] },
  locale: Locale,
): PluginSandboxPermissionDialogText {
  if (locale === "zh-CN") {
    const list = input.permissions.map((permission) => PERMISSION_LABELS.zh[permission]).join("、");
    return {
      title: "应用权限请求",
      message: `「${input.serverName}」的应用请求使用${list}`,
      detail:
        "该页面运行在 ZCode 的沙箱中。允许后，本次运行期间这个 MCP server 的应用可继续使用这些权限；重启桌面端后会再次询问。",
      allowButton: "允许",
      denyButton: "拒绝",
    };
  }
  const list = input.permissions.map((permission) => PERMISSION_LABELS.en[permission]).join(", ");
  return {
    title: "App permission request",
    message: `The "${input.serverName}" app wants to use your ${list}`,
    detail:
      "This page runs in the ZCode sandbox. If you allow it, apps from this MCP server can keep using these permissions until ZCode restarts.",
    allowButton: "Allow",
    denyButton: "Deny",
  };
}
