/**
 * 分析语料（tests/graphs/** 与各分析测试里的内联脚本）的诊断过滤。
 *
 * 语料脚本**从不执行**：它们的全部用途是钉住静态分析的产物（站点图、actor 图、因果图）。
 * 而 9006（fan-out 体内的静态 actor 名，见 src/analysis/actor-names.ts）说的是一件纯粹
 * **运行期**的事——那样的脚本跑起来会撞 DuplicateActorName。两者正交，所以语料对它豁免。
 *
 * 为什么不改语料（把 `agent("w")` 全改成 `` agent(`w-${item}`) ``）：那会把 26 个 fixture
 * 整体搬到 `ActorSite.namePattern` 那条**另一条**代码路径上，连带重生成约 78 份 golden，
 * 而「fan-out 里的静态名」恰恰是分析器必须继续正确处理的形状（`ActorNode.family`、actor
 * 标签都从它渲染）。为一条 authoring 规则删掉分析器的覆盖是反的。
 *
 * 豁免**只针对 9006**：9005（两处字面量同名）在语料里仍然必须为零——它是静态确定的事实，
 * 与脚本执不执行无关。两条子句分成两个码正是为了让这里能精确豁免，而不必匹配 message 文本。
 */

import type { CompileDiagnostic } from "../../src/index.js";
import { FANOUT_ACTOR_NAME_CODE } from "../../src/analysis/actor-names.js";

/** 语料关心的诊断：除 9006 之外的全部（语料脚本不运行，故 9006 不适用）。 */
export function corpusDiagnostics(diagnostics: CompileDiagnostic[]): CompileDiagnostic[] {
  return diagnostics.filter((d) => d.code !== FANOUT_ACTOR_NAME_CODE);
}
