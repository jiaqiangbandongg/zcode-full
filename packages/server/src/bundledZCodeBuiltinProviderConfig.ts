import { materializeZCodeBuiltinProviderConfig } from "@zcode/services/node";

declare const __ZCODE_BUILTIN_PROVIDER_CONFIG_JSON__: string | undefined;

export interface MaterializeBundledZCodeBuiltinProviderConfigOptions {
  readonly environmentConfigRoot: string;
  readonly content: string;
}

/** 返回构建时嵌入远端 Server 的 ZCode Built-in Provider Config。 */
export function readBundledZCodeBuiltinProviderConfig(): string {
  if (typeof __ZCODE_BUILTIN_PROVIDER_CONFIG_JSON__ !== "string") {
    throw new Error("当前构建未嵌入 ZCode Built-in Provider Config");
  }
  return __ZCODE_BUILTIN_PROVIDER_CONFIG_JSON__;
}

/**
 * 将 ZCode Built-in Config 原子物化到所属环境的固定资源副本。
 * 升级前退出旧进程；不保留按内容 hash 增长的历史文件。
 */
export async function materializeBundledZCodeBuiltinProviderConfig(
  options: MaterializeBundledZCodeBuiltinProviderConfigOptions,
): Promise<string> {
  return materializeZCodeBuiltinProviderConfig(options);
}
