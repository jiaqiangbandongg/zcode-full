/**
 * 沙箱安全：vm.createContext 求值单元的隔离契约（docs/execution-engine.md 的"The sandbox"）。
 * 这些脚本按设计**无法**通过 facade typecheck（直接摸 process/import 等），故绕开编译器，把手写的
 * lowered 函数体直接喂 harness——vm 契约本身才是被测对象，这是正当做法。
 */

import { describe, expect, it } from "vitest";
import { InMemoryJournalStore, type RunSettlement } from "@zcode/dynamic-workflow";
import { runWorkflowScript } from "../src/index.js";
import { AutoDriver } from "./auto-driver.js";
import { TEST_CWD } from "./helpers.js";

/** 直接投喂手写 lowered 体（自由标识符仅 `__host`），返回结算。 */
async function runLowered(lowered: string): Promise<RunSettlement> {
  const journal = new InMemoryJournalStore();
  const driver = new AutoDriver(journal);
  return runWorkflowScript({
    cwd: TEST_CWD,
    lowered,
    caps: { maxConcurrency: 4 },
    askSpecs: new Map(),
    validate: () => [],
    makeDriver: (sink) => {
      driver.attach(sink);
      return driver;
    },
    timeoutMs: 15000,
  });
}

/** 便捷：跑一个直接 return 表达式的沙箱体，取回 artifact。 */
async function evalInSandbox(expr: string): Promise<unknown> {
  const settlement = await runLowered(`return ${expr};`);
  expect(settlement.status).toBe("completed");
  return (settlement as { status: "completed"; artifact: unknown }).artifact;
}

describe("sandbox security — Node globals are absent", () => {
  it("process / fetch / require / globalThis.process are undefined", async () => {
    expect(await evalInSandbox('typeof process')).toBe("undefined");
    expect(await evalInSandbox('typeof fetch')).toBe("undefined");
    expect(await evalInSandbox('typeof require')).toBe("undefined");
    expect(await evalInSandbox('typeof globalThis.process')).toBe("undefined");
    expect(await evalInSandbox('typeof Buffer')).toBe("undefined");
    expect(await evalInSandbox('typeof global')).toBe("undefined");
  });

  it("ES intrinsics are present (curated globals, not a stripped realm)", async () => {
    expect(await evalInSandbox('typeof JSON')).toBe("object");
    expect(await evalInSandbox('typeof Promise')).toBe("function");
    expect(await evalInSandbox('Array.isArray([1,2])')).toBe(true);
  });
});

describe("sandbox security — dynamic import throws", () => {
  it("import() rejects with ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING", async () => {
    const result = await evalInSandbox(
      '(await (async () => { try { await import("node:fs"); return "NO-THROW"; } catch (e) { return String(e && (e.code || e.name)); } })())',
    );
    expect(result).toContain("ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING");
  });
});

describe("sandbox security — runtime nondeterminism bans (belt)", () => {
  it("Date.now() throws", async () => {
    expect(await evalInSandbox('(() => { try { Date.now(); return "NO"; } catch (e) { return e.message; } })()')).toContain(
      "Date.now()",
    );
  });

  it("argless new Date() throws; new Date(ms) is allowed", async () => {
    expect(await evalInSandbox('(() => { try { new Date(); return "NO"; } catch (e) { return e.message; } })()')).toContain(
      "argless new Date()",
    );
    // 带参构造仍可用（只有不确定性的无参形态被禁）。
    expect(await evalInSandbox("new Date(0).getTime()")).toBe(0);
  });

  it("Math.random() throws", async () => {
    expect(
      await evalInSandbox('(() => { try { Math.random(); return "NO"; } catch (e) { return e.message; } })()'),
    ).toContain("Math.random()");
  });
});

describe("sandbox security — eval binds to the same curated globals", () => {
  it('eval("process") sees undefined; eval("Date.now()") throws', async () => {
    // 动态创建的代码也绑定同一套 curated 全局：证明隔离不是靠静态改写脚本文本。
    expect(await evalInSandbox('eval("typeof process")')).toBe("undefined");
    expect(await evalInSandbox('(() => { try { eval("Date.now()"); return "NO"; } catch (e) { return "THREW"; } })()')).toBe(
      "THREW",
    );
  });
});
