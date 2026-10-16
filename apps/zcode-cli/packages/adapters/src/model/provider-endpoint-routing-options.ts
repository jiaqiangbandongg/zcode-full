import type { HttpClientPort, Logger } from "@zcode/contracts";

/** 由 bootstrap 注入的运行环境；实现不得修改 Provider 的持久化配置。 */
export interface ProviderEndpointRoutingFactoryOptions {
  endpointOrigin: string;
  appVersion?: string;
  httpClient: HttpClientPort;
  logger?: Logger;
  sourceHeaders?: () =>
    | Promise<Readonly<Record<string, string>>>
    | Readonly<Record<string, string>>;
}
