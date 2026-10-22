import { expectTypeOf, it } from "vitest";
import { settleToolResults } from "../../src/runtime/methods/tool-result-settlement.js";
import type { ToolResultSettlement } from "../../src/runtime/tool-result-settlement/contract.js";

// 行为与失败路径由既有 Runtime 结算测试覆盖；本契约不能缩窄输入或丢失 Runtime 的 this。
it("沿用原结算方法的调用方、参数及异步返回契约", () => {
  expectTypeOf(settleToolResults).toEqualTypeOf<ToolResultSettlement>();
  expectTypeOf<ReturnType<ToolResultSettlement>>().toEqualTypeOf<Promise<void>>();
});
