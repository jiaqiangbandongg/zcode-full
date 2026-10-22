/** 沿用现有函数签名；这里只声明边界，不复制选项表或参数校验。 */
export type CliArgumentsContract = Pick<
  typeof import("../arguments.js"),
  "parseGlobalArgs" | "extractDisallowedToolsArgs" | "isProtocolServerInvocation"
>;
