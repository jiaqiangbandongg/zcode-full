import type { SubagentRuntimeState } from "@zcode/shared";
/** 文件 IO 由 loader 完成；本模块只解析注入文本，不读取磁盘或补充 Host 快照。 */
export interface RuntimeSubagentConfiguration {
  documents: { content: string; path: string; namespace?: string; source: "user" | "project" }[];
  state: SubagentRuntimeState;
}
