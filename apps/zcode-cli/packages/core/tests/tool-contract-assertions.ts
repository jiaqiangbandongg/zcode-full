import { expect } from "vitest";
import type { ToolEntry } from "../src/tool/types.js";

/**
 * v2 common contract 的逐条断言，与 tool-contracts.test.ts 的全量循环同源。
 *
 * 抽出来是因为那个循环用 `expect` 在第一处不一致就中止：任何一个上游工具的既有偏差都会把
 * 它后面所有工具的这份检查永久遮住。新工具在自己的用例里再钉一遍，才能保证它是真的被检查过。
 */
export function expectV2CommonContract(entry: ToolEntry): void {
  const name = entry.metadata.name;
  expect(entry.capability, name).toBeTruthy();
  expect(entry.inputSchema, name).toEqual(expect.any(Object));
  expect(entry.outputSchema, name).toEqual(expect.any(Object));
  expect(entry.runtimeInputSchema, name).toBeTruthy();
  expect(entry.runtimeOutputSchema, name).toBeTruthy();
  expect(entry.permission.permission, name).toBeTruthy();
  expect(entry.permission.reason, name).toBeTruthy();
  expect(entry.permission.riskLevel, name).toBe(entry.metadata.riskLevel);
  expect(entry.permission.sideEffectScope, name).toBe(entry.metadata.sideEffectScope);
  expect(entry.permission.needsApproval, name).toBe(entry.metadata.needsApproval);
  expect(entry.resultBudget.maxInlineBytes, name).toBeGreaterThan(0);
  expect(entry.resultBudget.maxModelBytes, name).toBeGreaterThan(0);
  if (entry.timeout.kind === "none") {
    expect(entry.metadata.timeoutMs, name).toBeUndefined();
  } else {
    expect(entry.timeout.defaultMs, name).toBe(entry.metadata.timeoutMs);
  }
  expect(entry.cancellation.userVisibleMessage, name).toBeTruthy();
  expect(entry.trace.required, name).toBe(true);
}
