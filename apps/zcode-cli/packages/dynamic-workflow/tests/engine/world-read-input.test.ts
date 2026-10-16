// world-read / world-run 节点的有界输入（docs/dynamic-workflow/transcript-and-notifications.md）：
// 小输入原样、原类型；超限逐项截成预览并置 truncated；不可序列化的实参走同一条预览路。
import { describe, expect, it } from "vitest";
import { WORLD_READ_INPUT_MAX_BYTES } from "../../src/engine/types.js";
import { boundWorldReadInput } from "../../src/engine/world-read-input.js";

describe("boundWorldReadInput", () => {
  it("keeps a small input verbatim, argument types included", () => {
    const input = boundWorldReadInput("run", ["pnpm", ["vitest", "run"], { timeoutMs: 60_000 }]);
    expect(input).toEqual({ op: "run", args: ["pnpm", ["vitest", "run"], { timeoutMs: 60_000 }] });
    expect("truncated" in input).toBe(false);
  });

  it("copies the args array so later mutation by the caller cannot leak into the journal", () => {
    const args: unknown[] = ["src/a.ts"];
    const input = boundWorldReadInput("read", args);
    args.push("mutated");
    expect(input.args).toEqual(["src/a.ts"]);
  });

  it("truncates an oversized input into per-argument previews and says so", () => {
    const code = "x".repeat(WORLD_READ_INPUT_MAX_BYTES * 4);
    const input = boundWorldReadInput("run", ["node", ["-e", code], { timeoutMs: 1 }]);
    expect(input.op).toBe("run");
    expect(input.truncated).toBe(true);
    expect(input.args).toHaveLength(3);
    expect(input.args[0]).toBe("node");
    // 数组实参变成 JSON 预览、切尾加省略号；序列化后整体落在上限之内。
    expect(typeof input.args[1]).toBe("string");
    expect((input.args[1] as string).endsWith("…")).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(input)).length).toBeLessThanOrEqual(
      WORLD_READ_INPUT_MAX_BYTES,
    );
  });

  it("caps the number of previewed arguments", () => {
    const many = Array.from({ length: 40 }, (_, i) => "a".repeat(300) + i);
    const input = boundWorldReadInput("run", many);
    expect(input.truncated).toBe(true);
    expect(input.args.length).toBeLessThanOrEqual(8);
  });

  it("survives an unserialisable argument by falling back to previews", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const input = boundWorldReadInput("run", ["cmd", cyclic]);
    expect(input.truncated).toBe(true);
    expect(input.args[0]).toBe("cmd");
    expect(typeof input.args[1]).toBe("string");
  });
});
