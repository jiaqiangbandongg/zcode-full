/**
 * engine.ts 顶到 oxlint max-lines 上限（400 行），把 `report()` 的发布路径（序列化探针、
 * replay 去重、标签校验、两个上限、一次写）拆到本文件；公开面仍从 engine.ts 导出。
 *
 * 自由函数经 {@link EngineState} 接缝读写引擎状态；WorkflowEngine.report 只是薄委托。
 */

import { inputHash } from "./hash.js";
import { REPORT_CAPS } from "../facade/report-caps.js";
import { declaredPresetIds, isDeclaredPreset } from "./engine-artifacts.js";
import { hashMismatch } from "./hash-mismatch.js";
import type { EngineState } from "./engine-state.js";
import type { InstanceRef } from "./types.js";
import { refToString, WorkflowError } from "./types.js";

/**
 * 发布一条中间结果（Boundary A 的 `report`）。同步、无返回值、无 driver 往返：
 * 落一行 journal + 发一个事件就结束。
 *
 * 四件事，顺序是有讲究的：
 *
 * 1. **序列化探针先行**。用 `JSON.stringify` 一次拿到两样东西：item 到底能不能被 JSON
 *    表示，以及它的字节数（上限的度量）。必须在 canonicalJson 之前——带环的 item 会让
 *    canonicalJson 递归爆栈，那是一次崩溃而不是一次可读的失败。
 * 2. **replay 命中即跳过**：不发事件、不重写记录。跳过之前先比对 inputHash，不一致按
 *    纯度违约让 run 大声失败。这条比对是**防御性的**（一条报告派生自 journal 已经钉住的
 *    值），但它是免费的，而这里的偏移意味着整个 replay 不可靠——Results 面板的读者绝不
 *    应该在不知情的情况下看到那种东西。
 * 3. **上限先于落库**：单条字节数、条数、run 级字节总数任一超出即 `ReportCapExceeded`
 *    失败整个 run。
 *    run 级而非 node 级，因为 `report` 返回 `void`，没有可拒绝进去的地方。
 * 4. **一次写**：`completed`、无 actor 字段。
 */
export function publishReport(
  state: EngineState,
  siteId: string,
  item: unknown,
  artifactId?: string,
): void {
  if (state.isRunSettled()) return; // 与 log 同：结算之后不再受理
  const ordinal = state.nextOrdinal(siteId);
  const instance: InstanceRef = { siteId, ordinal };

  const serialized = probeReportItem(state, instance, item);
  if (serialized === undefined) return; // 探针已 failRun
  // inputHash 刻意**只覆盖 item**，标签不进哈希：标签是站点上的编译期字面量，而 resume
  // 要求脚本逐字节相同（script_hash），所以同一 (siteId, ordinal) 的标签不可能变。把它加进
  // 哈希输入的唯一效果，是让**每一条**既有 journal 里的无标签 report 在 resume 时
  // InputHashMismatch——一次没有任何收益的破坏性载荷形变。
  const hash = inputHash(item);

  // 只比对哈希，不读 item（docs/execution-engine.md「Reading the journal」）：resume 重放一个
  // 报了 65,536 条的脚本时，每一次命中都去解一条 ≤1 MiB 的 item 再扔掉，是按总字节数付的钱。
  const recorded = state.journal.getNode(state.runId, siteId, ordinal, { withResult: false });
  if (recorded !== undefined) {
    if (recorded.inputHash !== hash) {
      state.failRun(hashMismatch(instance, recorded.inputHash, hash));
      return;
    }
    return; // replay 去重：静默跳过（无事件、不重复 append）
  }

  // 标签在场：它必须已经被声明为**预置**产物。查在上限之前——一个指向不存在看板的标签
  // 是脚本写错了，不是容量事件，两者混在一起会让错误码骗人。
  // failRun 而不是拒绝，理由与 report 的两个上限完全相同：void 返回没有拒绝通道。
  if (artifactId !== undefined && !isDeclaredPreset(state, artifactId)) {
    state.failRun(
      new WorkflowError(
        "ArtifactUndeclared",
        `report() tag "${artifactId}" is not a declared preset artifact ` +
          `(at ${refToString(instance)}). Declare it once at the top of the script, e.g. ` +
          `artifact.chart("${artifactId}", …), before tagging reports with it. Declared presets: ` +
          `${declaredPresetIds(state).join(", ") || "(none)"}.`,
      ),
    );
    return;
  }

  if (!reserveReport(state, instance, serialized)) return;
  state.journal.putNode({
    runId: state.runId,
    siteId,
    ordinal,
    kind: "report",
    inputHash: hash,
    status: "completed",
    result: item,
    // 打了标签的 report 行是「看板 = journal 的投影」这条不变式的落点：一个看板的每个点
    // 就是一行 kind = report ∧ artifact_id = 该 id。
    ...(artifactId === undefined ? {} : { artifactId }),
  });
  state.record({
    type: "report",
    instance,
    item,
    ...(artifactId === undefined ? {} : { artifactId }),
  });
}

/**
 * report 的**运行期 JSON 护栏**（编译期的可序列化诊断是 suspenders，这里是 belt）。
 * 返回 item 的序列化文本；不可表示时 failRun 并返回 undefined。
 *
 * 为什么用 `JSON.stringify` 而不是 `canonicalJson`：canonicalJson 是**全函数**的（把
 * undefined/函数静默折成 `"null"`，遇到环则递归爆栈），这正是它作为哈希输入该有的样子，
 * 但作为护栏它会把一个残缺的 item 悄悄落进 journal。`JSON.stringify` 相反：环与 bigint
 * 抛错、undefined/函数/symbol 返回 undefined——两种情形都能被抓成一次大声的失败。
 *
 * 错误码选 `DriverError` 而不是 `ReportCapExceeded`：这不是一个上限（上限是数量），而是
 * 「item 不是 JSON」这条契约被破坏，而那条契约的正门是编译期诊断。走到这里说明有东西
 * 绕过了正门（典型是经 `any` 造出的环），所以它是一次契约破裂而不是一次容量事件——
 * 让 `ReportCapExceeded` 只表示上限，读者才能据码行动。
 */
function probeReportItem(
  state: EngineState,
  instance: InstanceRef,
  item: unknown,
): string | undefined {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(item);
  } catch (cause) {
    state.failRun(
      new WorkflowError(
        "DriverError",
        `report() item cannot be serialized to JSON (a cycle or a bigint) at ` +
          `${refToString(instance)}. Report a plain JSON value.`,
        { cause },
      ),
    );
    return undefined;
  }
  if (serialized === undefined) {
    // JSON.stringify 对 undefined / 函数 / symbol 返回 undefined。
    state.failRun(
      new WorkflowError(
        "DriverError",
        `report() item is not a JSON value (undefined, a function or a symbol) at ` +
          `${refToString(instance)}. Report a plain JSON value.`,
      ),
    );
    return undefined;
  }
  return serialized;
}

/**
 * report 的三个上限（单条字节数、条数、run 级字节总数）。任一超出即 failRun 并返回 false。
 *
 * 顺序按「错在哪一条」：单条过大是这一条 item 的问题，与 run 攒了多少无关，所以先判；两个
 * run 级上限在后，且都在计数之前——被拒的那条不进计数，失败信息里的数字才是真的。
 */
function reserveReport(state: EngineState, instance: InstanceRef, serialized: string): boolean {
  const bytes = utf8ByteLength(serialized);
  if (bytes > REPORT_CAPS.maxItemSerializedBytes) {
    state.failRun(
      new WorkflowError(
        "ReportCapExceeded",
        `report() item at ${refToString(instance)} is ${bytes} bytes, over the ` +
          `${REPORT_CAPS.maxItemSerializedBytes}-byte limit. Report a summary instead.`,
      ),
    );
    return false;
  }
  const tally = state.reportTally();
  if (tally.count >= REPORT_CAPS.maxItemsPerRun) {
    state.failRun(
      new WorkflowError(
        "ReportCapExceeded",
        `This run already reported ${REPORT_CAPS.maxItemsPerRun} items, the maximum. ` +
          `Report findings, not chatter.`,
      ),
    );
    return false;
  }
  if (tally.bytes + bytes > REPORT_CAPS.maxBytesPerRun) {
    state.failRun(
      new WorkflowError(
        "ReportCapExceeded",
        `report() item at ${refToString(instance)} would take this run's reports to ` +
          `${tally.bytes + bytes} bytes, over the ${REPORT_CAPS.maxBytesPerRun}-byte limit per run. ` +
          `Report summaries, and publish large results with artifact.file.`,
      ),
    );
    return false;
  }
  state.countReport(bytes);
  return true;
}

/**
 * 一个字符串的 UTF-8 字节数（report 单条上限的度量）。用 `TextEncoder`（ECMAScript/WHATWG
 * 标准全局）而不是 `Buffer.byteLength`：本包保持零 node 内建依赖。上限论的是**字节**而非
 * 字符——一份中文 findings 的字符数只有字节数的三分之一，按字符计会让上限形同虚设。
 */
function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}
