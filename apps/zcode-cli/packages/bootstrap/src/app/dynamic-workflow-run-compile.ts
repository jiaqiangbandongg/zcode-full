// ============================================================
// 「编译一次」：一个 ts.Program 同时喂站点表、schema 合成与 lowering
// ============================================================
// 从 dynamic-workflow-run-submit.ts 拆出（max-lines 门）：submit / amend 用 compileOnce，resume 先用同一个
// Program 取诊断（boundedResumeDiagnostics）再交给 compileProgram。纯编译，不碰注册表与 journal。

import { createHash } from "node:crypto";
import {
  buildAskSpecs,
  collectSites,
  collectWorldRunCommands,
  createWorkflowProgram,
  collectPhaseNames,
  collectSitePhases,
  deriveActorSubmitProfiles,
  interpret,
  lowerWorkflow,
  projectControlFlow,
  synthesizeAskSchemas,
  type CompileDiagnostic,
  type SiteTable,
  type WorkflowProgram,
} from "@zcode/dynamic-workflow";
import { projectSiteGraph } from "@zcode/dynamic-workflow/projections";
import { compiledHolesOf } from "./dynamic-workflow-run-holes.js";
import type { CompiledDynamicWorkflowScript } from "./dynamic-workflow-run-launch.js";

/**
 * 编译一次：一个 ts.Program 同时喂站点表、schema 合成与 lowering。
 *
 * 脏脚本在这里硬失败且**不建 run**：handler 只在 `ok` 时才调 submit，所以走到这里的脏脚本
 * 只可能是接线错误。防御性检查读的是同一次编译的程序诊断，不再起第二个 Program
 * （那会破坏「编译一次」）。resume 用同一个函数重编 journal 里的原文——byte-identical 的
 * 脚本必然重新通过同一套检查。
 */
export function compileOnce(scriptText: string): CompiledDynamicWorkflowScript {
  return compileProgram(scriptText, createWorkflowProgram(scriptText));
}

/** resume 拒绝文案里诊断的上限（与中枢直接启动的 compile_failed 同一量级）。 */
const RESUME_DIAGNOSTICS_MAX_CHARS = 2000;

/** compile_failed 的人可读诊断：一行一条 `L:C message`，整体有界。 */
export function boundedResumeDiagnostics(runId: string, diagnostics: CompileDiagnostic[]): string {
  const body = [
    `The stored script of run ${runId} no longer compiles against the current workflow facade:`,
    ...diagnostics.map(
      (diagnostic) => `L${diagnostic.line}:C${diagnostic.column} ${diagnostic.message}`,
    ),
  ].join("\n");
  return body.length > RESUME_DIAGNOSTICS_MAX_CHARS
    ? `${body.slice(0, RESUME_DIAGNOSTICS_MAX_CHARS - 1)}…`
    : body;
}

/**
 * compileOnce 的后半段：对**已建好的** Program 做站点表 / schema 合成 / lowering。resume 先用同一个
 * Program 取诊断再交到这里，仍是「编译一次」（Program 缓存自己的诊断，重读不重算）。
 */
export function compileProgram(
  scriptText: string,
  workflow: WorkflowProgram,
  /**
   * 已经收集过的站点表（补全服务在稳定性复核前先收集了一次，同一个 Program 上不必再走一遍）。
   * 缺席即在这里收集。
   */
  collected?: SiteTable,
): CompiledDynamicWorkflowScript {
  const diagnostics = [
    ...workflow.program.getSyntacticDiagnostics(),
    ...workflow.program.getSemanticDiagnostics(),
  ];
  if (diagnostics.length > 0) {
    throw new Error(
      `dynamic workflow submit received a script that does not typecheck (${diagnostics.length} diagnostics); no run was created`,
    );
  }

  const table = collected ?? collectSites(workflow);
  const { diagnostics: schemaDiagnostics, schemas } = synthesizeAskSchemas(workflow, table);
  if (schemaDiagnostics.length > 0) {
    throw new Error(
      `dynamic workflow submit received a script with unsupported ask result types: ${schemaDiagnostics
        .map((diagnostic) => `L${diagnostic.line}:C${diagnostic.column} ${diagnostic.message}`)
        .join("; ")}`,
    );
  }
  // world.run 的授权面就是编译期字面量（9003）+ 确认窗展示；driver 不再另持一份命令集复验
  // （workflow-world-read.ts 文件头第 2 条）。非字面量 cmd 在 handler 的 analyze 阶段已经挡回；
  // 到这里还出现即接线错误，硬失败不建 run。
  const worldRun = collectWorldRunCommands(workflow, table);
  if (worldRun.diagnostics.length > 0) {
    throw new Error(
      `dynamic workflow submit received a script with non-literal world.run commands (${worldRun.diagnostics.length} diagnostics); no run was created`,
    );
  }

  // buildAskSpecs 是 askSpecs 的唯一正确构造：untyped 站点显式记 {typed:false}。
  // 用 schemas 的键去构造会让 untyped 站点整个缺席，而引擎把缺席当接线错误硬失败。
  const askSpecs = buildAskSpecs(table, schemas);

  // 在**同一个** Program 上做一次解释（analyzeWorkflowScript 在 handler 的 analyze 阶段已对同一份
  // 文本跑过），仍是「编译一次」；两份产物从同一个 core 上读：submit profile 走站点图投影，
  // 词法出生阶段表直接读 trace（docs/execution-engine.md「Identity: sites, ordinals, phases」）。
  // resume 用同一函数对 byte-identical 文本重算，确定性成立。
  const core = interpret(workflow, table);
  const lowered = lowerWorkflow(workflow, table);

  return {
    askSpecs,
    // 每个 actor 站点的 submit profile（docs/execution-engine.md「Submit profiles」）。
    actorSubmitProfiles: deriveActorSubmitProfiles(projectSiteGraph(core), askSpecs),
    sitePhases: collectSitePhases(core),
    lowered: lowered.code,
    // 留白（docs/execution-engine.md「Holes」）：已补全留白的函数体文本是补全交给引擎的 `code`
    // ——与脚本其余部分同一次 lowering 产出，现补与日后重放执行的是逐字节相同的文本；留白的
    // 编译期事实表（名字 / 类型 / 行）供快照与进度载荷读；阶段表按控制流投影取（留白按名字
    // 占位，与 contracts 的 createWorkflowPhaseNames 同一来源），补全后重算的表因此与 launch 时
    // 的表按同一条规则对齐。
    holeBodies: lowered.holeBodies,
    holes: compiledHolesOf(table),
    phases: collectPhaseNames(projectControlFlow(core)),
    // scriptHash 的所有权在**这里**，不在 harness。harness 同时收 scriptText 与 lowered，
    // 且刻意不校验两者是否自洽——校验等于把编译再跑一遍，正是「编译一次」要省掉的那次
    // （harness.ts 把这条写成了调用方的不变式）。所以哈希必须算在作者原文上：
    // 若让 harness 哈希「它看到的文本」，lowered 路径落库的就是 lowered 函数体的哈希，
    // 而 resume 比对的是作者原文 —— 比对对象会静默错位。本函数从同一次编译里同时产出
    // lowered 与 hash，两者按构造自洽。
    scriptHash: createHash("sha256").update(scriptText, "utf8").digest("hex"),
  };
}
