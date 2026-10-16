/**
 * resume 分支从 journal 恢复的 run 级状态（docs/execution-engine.md「Resume by replay」与
 * 「Reading the journal」）：结算次序闸、每个 actor 的已记录 ask 数、报告计数、产物状态。
 *
 * 拆出原因：engine.ts 顶到 oxlint max-lines 上限（400 行）。
 *
 * 节点行只读一次、只读要的列：工作行不带结果（次序闸与 ask 计数只看 kind / status / 坐标），
 * 产物行带结果（成员族与版本记录在 `result` 上，且有界），报告行只数条数与字节、不读——一个
 * run 可以有 65,536 条、1 GiB 的 item，恢复它们的计数不需要把任何一条读进内存。
 */

import { rememberArtifactRow } from "./engine-artifacts.js";
import type { EngineState, ReportTally } from "./engine-state.js";
import { readReplayRows, recoverSettleOrder, type ReplaySettleOrder } from "./replay-order.js";
import type { AskScheduler } from "./scheduler.js";

export function restoreFromJournal(
  state: EngineState,
  scheduler: AskScheduler,
): { replaySettleOrder: ReplaySettleOrder; reportTally: ReportTally } {
  const { workRows, artifactRows } = readReplayRows(state.journal, state.runId);
  // 结算次序按本 run 自己的事件恢复（本闸是 replay 正确性的一部分，不是观察面：站点序号依
  // 调用到达顺序，而扇出的到达顺序只有首生的结算次序能复现）。
  const replaySettleOrder = recoverSettleOrder(state.journal, state.runId, [
    ...workRows,
    ...artifactRows,
  ]);
  scheduler.seedRecordedAsks(workRows);
  // 产物状态与报告计数同席恢复：id 归属（种类、预置 spec）与已成功版本数全部由 journal 行派生，
  // 所以崩溃恢复后第 3 版仍然是第 3 版，而不是从 1 重新数起。
  for (const node of artifactRows) {
    if (node.status !== "completed") continue;
    rememberArtifactRow(state, node.artifactId, node.result);
  }
  // 报告计数按 kind:"report" 的行恢复：上限是 run 级的，跨 resume 必须连续。条数是 count(*)，
  // 字节数是 result_json 的字节和——SQLite 从行头读长度，一条 item 都不读出来。
  return {
    replaySettleOrder,
    reportTally: {
      count: state.journal.countNodes(state.runId, "report"),
      bytes: state.journal.sumResultBytes(state.runId, "report"),
    },
  };
}
