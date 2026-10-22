import { TOOL_SEARCH_BETA, type ToolSearchCapability } from "@zcode/contracts";

export function resolveToolSearchCapability(
  apiType: string,
  access: { type: string; mode?: string },
): ToolSearchCapability {
  const protocolSupported = apiType === "anthropic-messages";
  const codingPlan =
    access.type === "zhipu-coding-plan-api-key" ||
    (access.type === "zhipu-account" &&
      (access.mode === "individual-coding-plan" || access.mode === "team-coding-plan"));
  return Object.freeze({ protocolSupported, defaultEnabled: protocolSupported && codingPlan });
}

export function toolSearchHeaders(headers: Record<string, string> | undefined, enabled?: boolean) {
  if (!enabled) return headers;
  const result = { ...headers };
  const key =
    Object.keys(result).find((name) => name.toLowerCase() === "anthropic-beta") ?? "anthropic-beta";
  result[key] = [
    ...new Set([
      ...(result[key]
        ?.split(",")
        .map((value) => value.trim())
        .filter(Boolean) ?? []),
      TOOL_SEARCH_BETA,
    ]),
  ].join(",");
  return result;
}
