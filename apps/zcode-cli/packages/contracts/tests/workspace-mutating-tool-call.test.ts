import { describe, expect, it } from "vitest";
import {
  isWorkspaceMutatingToolCall,
  isWorldTouchingToolCall,
  WORKSPACE_MUTATING_SIDE_EFFECT_SCOPES,
} from "../src/tools/contract.js";

// 「第一笔写入」的判定（apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md「Amend-resume」）：
// 执行器上载荷、driver 读载荷，两边用的就是这一个函数。
describe("isWorkspaceMutatingToolCall", () => {
  it("only workspace, git and system scopes touch the workspace", () => {
    expect([...WORKSPACE_MUTATING_SIDE_EFFECT_SCOPES].sort()).toEqual([
      "git",
      "system",
      "workspace",
    ]);
    for (const scope of ["workspace", "git", "system"] as const) {
      expect(isWorkspaceMutatingToolCall({ readOnly: false, sideEffectScope: scope }), scope).toBe(
        true,
      );
    }
    for (const scope of ["none", "network", "session", "userInteraction"] as const) {
      expect(isWorkspaceMutatingToolCall({ readOnly: false, sideEffectScope: scope }), scope).toBe(
        false,
      );
    }
  });

  it("a read-only call never counts, even in a mutating scope (Bash `ls` is scope none but the rule holds regardless)", () => {
    expect(isWorkspaceMutatingToolCall({ readOnly: true, sideEffectScope: "workspace" })).toBe(
      false,
    );
    expect(isWorkspaceMutatingToolCall({ readOnly: true, sideEffectScope: "system" })).toBe(false);
  });

  it("an undeclared scope is treated as a write (an event from before the flags existed, or a tool that never said)", () => {
    expect(isWorkspaceMutatingToolCall({})).toBe(true);
    expect(isWorkspaceMutatingToolCall({ readOnly: false })).toBe(true);
    expect(isWorkspaceMutatingToolCall({ readOnly: undefined, sideEffectScope: undefined })).toBe(
      true,
    );
  });
});

// 「碰过外部世界」的判定（同一份 spec）：决定一条缓存条目是不是纯的。
describe("isWorldTouchingToolCall", () => {
  it("only the protocol scopes are exempt: handing a result back or asking is not touching the world", () => {
    for (const scope of ["session", "userInteraction"] as const) {
      expect(isWorldTouchingToolCall({ sideEffectScope: scope }), scope).toBe(false);
    }
    for (const scope of ["none", "workspace", "git", "system", "network"] as const) {
      expect(isWorldTouchingToolCall({ sideEffectScope: scope }), scope).toBe(true);
    }
  });

  it("a read counts: Read declares scope none, yet its answer depends on the workspace", () => {
    expect(isWorldTouchingToolCall({ sideEffectScope: "none" })).toBe(true);
    // 与「写」的判定分工：读不关门，但它让条目不再是纯的。
    expect(isWorkspaceMutatingToolCall({ readOnly: true, sideEffectScope: "none" })).toBe(false);
  });

  it("an undeclared scope counts as touching (conservative, same as the write predicate)", () => {
    expect(isWorldTouchingToolCall({})).toBe(true);
  });
});
