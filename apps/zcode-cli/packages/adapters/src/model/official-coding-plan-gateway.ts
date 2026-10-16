import type {
  ProviderEndpointRoutingDecision,
  ProviderEndpointRoutingPort,
} from "@zcode/contracts";

const HTTPS_DEFAULT_PORT = "443";
const ROOT_PATH = "/";
const GATEWAY_PATH_BY_ENDPOINT: ReadonlyMap<string, string> = new Map([
  ["https://open.bigmodel.cn:443/api/anthropic/v1/messages", "/api/v1/ultra/anthropic/v1/messages"],
  ["https://api.z.ai:443/api/anthropic/v1/messages", "/api/v1/ultra-zai/anthropic/v1/messages"],
]);

/** 静态实现只提供 URL 决策；Host 清理、请求与响应透传由公共 fetch wrapper 负责。 */
export function createStaticProviderEndpointRoutingPort(
  endpointOrigin: string,
): ProviderEndpointRoutingPort {
  return {
    async resolve(requestUrl): Promise<ProviderEndpointRoutingDecision> {
      let parsed: URL;
      try {
        parsed = new URL(requestUrl);
      } catch {
        return { routed: false, url: requestUrl };
      }
      if (parsed.protocol !== "https:") return { routed: false, url: requestUrl };
      const path =
        parsed.pathname === ROOT_PATH
          ? ROOT_PATH
          : parsed.pathname.replace(/\/+$/u, "") || ROOT_PATH;
      const key = `${parsed.protocol}//${parsed.hostname.toLowerCase()}:${parsed.port || HTTPS_DEFAULT_PORT}${path}`;
      const targetPath = GATEWAY_PATH_BY_ENDPOINT.get(key);
      if (!targetPath) return { routed: false, url: requestUrl };
      const target = new URL(targetPath, endpointOrigin);
      target.search = parsed.search;
      return { routed: true, url: target.href };
    },
  };
}
