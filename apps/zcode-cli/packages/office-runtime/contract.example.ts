/**
 * office-runtime 标准用法示例：PDF 插件在 package.json 里声明的面板配置，以及构建后可依赖的产物。
 */
import { OFFICE_RUNTIME_OUTPUTS, type OfficeRuntimeContract } from "./contract.ts";

export function examplePdfPlugin(): OfficeRuntimeContract {
  return {
    config: { title: { en: "PDF", "zh-CN": "PDF" }, kinds: ["pdf"] },
    outputs: OFFICE_RUNTIME_OUTPUTS,
  };
}
