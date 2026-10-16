/**
 * 运行实参 `args` 经**真实入口**抵达沙箱：runWorkflowScript → ChildPayload → vm context。
 *
 * 这条链上有四个可以静默断掉的接头（options → payload、payload → sandbox 全局、BOOTSTRAP
 * 的 `__host.args`、lowering 的 `args` → `__host.args`），而断掉的表现都一样：脚本读到
 * `undefined` 或直接 ReferenceError。所以这里跑的是真子进程，不是桩。
 *
 * 另一半（实参落 dwf_run.args_json、resume 从那里读回重放）由 run-metadata 的断言与
 * bootstrap 的 resume 测试各守一头。
 */

import { describe, expect, it } from "vitest";
import { InMemoryJournalStore } from "@zcode/dynamic-workflow";
import { runWorkflowScript } from "../src/index.js";
import { AutoDriver } from "./auto-driver.js";
import { askSpecsFor, TEST_CWD } from "./helpers.js";

const RUN = "run";

function baseOptions(scriptText: string, journal: InMemoryJournalStore) {
  const driver = new AutoDriver(journal, {});
  return {
    scriptText,
    cwd: TEST_CWD,
    runId: RUN,
    caps: { maxConcurrency: 16 },
    askSpecs: askSpecsFor(scriptText),
    validate: () => [],
    makeDriver: (sink: Parameters<typeof driver.attach>[0]) => {
      driver.attach(sink);
      return driver;
    },
    timeoutMs: 20000,
  };
}

describe("args in the sandbox", () => {
  it("delivers the validated bag to the script", async () => {
    const journal = new InMemoryJournalStore();
    const script = "return [String(args.target), Number(args.depth), args.deep];";

    const settlement = await runWorkflowScript({
    cwd: TEST_CWD,
      ...baseOptions(script, journal),
      args: { target: "packages/core", depth: 3, deep: { nested: true } },
    });

    expect(settlement).toEqual({
      status: "completed",
      artifact: ["packages/core", 3, { nested: true }],
    });
  });

  // 不变式 7：`args` 恒有定义。内联 run 读 `args.x` 必须是一次合法的属性读，
  // 不是一次 ReferenceError——这正是 payload 缺席时编码成 "{}" 那一行守的东西。
  it("is an empty object, never undefined, for a run with no arguments", async () => {
    const journal = new InMemoryJournalStore();
    const script = "return [typeof args, Object.keys(args).length, args.missing === undefined];";

    const settlement = await runWorkflowScript(baseOptions(script, journal));

    expect(settlement).toEqual({ status: "completed", artifact: ["object", 0, true] });
  });

  it("journals the args alongside the rest of the run metadata", async () => {
    const journal = new InMemoryJournalStore();

    await runWorkflowScript({
    cwd: TEST_CWD,
      ...baseOptions("return String(args.who);", journal),
      args: { who: "ada" },
    });

    // resume 读的就是这一份：run 的身份包含它的实参（不变式 6）。
    expect(journal.getRun(RUN)?.args).toEqual({ who: "ada" });
  });

  it("leaves args off the run record entirely when the run had none", async () => {
    const journal = new InMemoryJournalStore();
    await runWorkflowScript(baseOptions("return 1;", journal));
    // 缺席的键，不是 `{}`：记录层面保持「没有实参」与「实参是空袋」可分辨。
    expect(journal.getRun(RUN)?.args).toBeUndefined();
  });

  // 冻结是**浅**的（child-source 的注释说明了这个界限）：顶层重新赋值静默失败（非严格
  // 模式的 lowered 体里）或抛错，而嵌套对象仍可改。这条钉住顶层那一半，也钉住"改动不
  // 穿透回宿主"——宿主拿到的实参袋不该被脚本改写。
  it("freezes the top level of the bag", async () => {
    const journal = new InMemoryJournalStore();
    const script = [
      "const frozen = Object.isFrozen(args);",
      "let threw = false;",
      "try { (args as Record<string, unknown>).injected = 1; } catch { threw = true; }",
      "return [frozen, threw || args.injected === undefined];",
    ].join("\n");

    const settlement = await runWorkflowScript({
    cwd: TEST_CWD,
      ...baseOptions(script, journal),
      args: { original: 1 },
    });

    expect(settlement).toEqual({ status: "completed", artifact: [true, true] });
    // 宿主侧那一份没有被脚本碰过。
    expect(journal.getRun(RUN)?.args).toEqual({ original: 1 });
  });
});
