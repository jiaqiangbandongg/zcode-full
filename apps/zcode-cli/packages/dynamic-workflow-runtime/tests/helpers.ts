/**
 * 集成测试共享装配：脚本文本 → 真实 schema 合成 + 真实 validate + 真实 lowering → 沙箱子进程
 * → 引擎核心 → AutoDriver。整条 phase-1 管线（短一个真模型）都在这里跑通。
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InMemoryJournalStore,
  buildAskSpecs,
  collectSites,
  createWorkflowProgram,
  synthesizeAskSchemas,
  validate,
  type AskSpec,
  type Caps,
  type JsonSchema,
  type RunSettlement,
  type ValidateFn,
} from "@zcode/dynamic-workflow";
import { runWorkflowScript } from "../src/index.js";
import { AutoDriver, type AutoDriverConfig } from "./auto-driver.js";

/** 适配真实校验器到引擎的 ValidateFn 契约（schema: JsonSchema → unknown 的形参放宽）。 */
const validateFn: ValidateFn = (schema, value) => validate(schema as JsonSchema, value);

/**
 * 由脚本文本合成 ask 规格：走包里的规范构造器 {@link buildAskSpecs}（按站点表遍历，
 * untyped 站点显式记 `{typed:false}`——引擎把站点缺席当接线错误硬失败）。
 *
 * 同时演示「编译一次」：一个 ts.Program 同时喂站点表与 schema 合成。
 */
export function askSpecsFor(scriptText: string): Map<string, AskSpec> {
  const workflow = createWorkflowProgram(scriptText);
  const table = collectSites(workflow);
  const { schemas } = synthesizeAskSchemas(workflow, table);
  return buildAskSpecs(table, schemas);
}

interface RunScriptResult {
  settlement: RunSettlement;
  journal: InMemoryJournalStore;
  driver: AutoDriver;
}

interface RunScriptOptions extends AutoDriverConfig {
  caps?: Caps;
  timeoutMs?: number;
  journal?: InMemoryJournalStore;
  runId?: string;
  /** 外部取消信号（resume 测试用它把首趟打断在执行中，制造 running 记录）。 */
  signal?: AbortSignal;
}

const DEFAULT_CAPS: Caps = { maxConcurrency: 16 };

/**
 * 每个测试文件一份独立的 run cwd。harness 把入口文件写到 `<cwd>/.zcode/workflow-runs/<runId>.mjs`
 * 且**保留**；测试几乎都用 runId "run"，若共用 process.cwd()，并行的测试文件会互相覆写同一个
 * 入口文件（一个子进程跑成另一个文件的脚本），也会把存档留在包目录里。vitest 按文件隔离模块，
 * 这个常量因此是每文件一份；文件内的用例串行，同名覆写无害。
 */
export const TEST_CWD: string = mkdtempSync(join(tmpdir(), "dwf-test-cwd-"));

/** 用真实管线跑一份脚本；AutoDriver 按 opts 里的 asks/worldReads 自动扮演模型。 */
export async function runScript(scriptText: string, opts: RunScriptOptions = {}): Promise<RunScriptResult> {
  const journal = opts.journal ?? new InMemoryJournalStore();
  const driver = new AutoDriver(journal, {
    asks: opts.asks,
    worldReads: opts.worldReads,
    artifacts: opts.artifacts,
    onStartAsk: opts.onStartAsk,
  });
  const settlement = await runWorkflowScript({
    scriptText,
    cwd: TEST_CWD,
    runId: opts.runId ?? "run",
    caps: opts.caps ?? DEFAULT_CAPS,
    askSpecs: askSpecsFor(scriptText),
    validate: validateFn,
    makeDriver: (sink) => {
      driver.attach(sink);
      return driver;
    },
    timeoutMs: opts.timeoutMs ?? 20000,
    ...(opts.signal === undefined ? {} : { signal: opts.signal }),
  });
  return { settlement, journal, driver };
}
