import type { CliArgumentsContract } from "./contract.js";

/** 先提取可变长度工具规则，再交给同一个严格全局解析器。 */
export function exampleCliArguments(contract: CliArgumentsContract) {
  const extracted = contract.extractDisallowedToolsArgs([
    "--disallowedTools",
    "WebFetch",
    "--toolsearch-mode",
    "local",
    "--prompt",
    "hello",
  ]);
  return {
    ...contract.parseGlobalArgs(extracted.args),
    toolDisallowlist: extracted.toolDisallowlist,
  };
}
