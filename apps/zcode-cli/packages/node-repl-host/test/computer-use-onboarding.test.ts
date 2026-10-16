import { describe, expect, it, vi } from "vitest";

/**
 * CUA 的输出策略：参考按需取用，宿主不主动推。
 *
 * Bug（2026-09-11 真机）：首次 CUA 调用前 SDK 会把 docs/computer-use.md 自动写进输出，
 * 而模型刚通过 Skill 工具拿到大面积重合的 SKILL——同一份内容进上下文两遍（13.1KB +
 * 13.8KB，小节重合过半）。口径改成与 Browser Use 一致：文档由模型自己
 * `nodeRepl.write(await agent.documentation.get("computer-use"))` 取。
 *
 * 观察结果仍由 SDK 自动展示（`Target`）：v1 曾把它写成 SKILL 里的纪律，
 * 模型忘写就整段观察丢失，那次回退的结论保留在 computer-use-client.mjs 的注释里。
 */

const WRITTEN: string[] = [];

async function makeGlobals(bridgeOverrides: Record<string, unknown> = {}) {
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const clientUrl = fileURLToPath(new URL("../../zcode-cua-plugin/scripts/computer-use-client.mjs", import.meta.url));
  const documentationRoot = join(dirname(clientUrl), "..", "docs");
  const bridge = {
    call: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] })),
    assertAvailable: () => {},
    documentationRoot,
    ...bridgeOverrides,
  };
  const globals = {
    [Symbol.for("zcode.node-repl.computer-use-bridge")]: bridge,
    nodeRepl: { write: (text: string) => { WRITTEN.push(text); } },
  };
  const mod = await import(clientUrl);
  await mod.setupComputerUseRuntime({ globals });
  return { globals, bridge, mod };
}

const referenceOf = (writes: readonly string[]) =>
  writes.find((text) => text.startsWith("# Computer Use"));

describe("computer-use output policy", () => {
  it("never pushes the reference, on the first call or any later one", async () => {
    WRITTEN.length = 0;
    const { globals } = await makeGlobals();
    await globals.agent.computerUse.computer.list_apps({});
    expect(referenceOf(WRITTEN)).toBeUndefined();
    await globals.agent.computerUse.computer.list_apps({});
    expect(referenceOf(WRITTEN)).toBeUndefined();
  });

  it("serves the reference through agent.documentation for the model to write", async () => {
    const { globals } = await makeGlobals();
    const doc = await (
      globals.agent as { documentation: { get: (name: string) => Promise<string> } }
    ).documentation.get("computer-use");
    expect(doc).toMatch(/^# Computer Use/u);
    // 按需取用的那份仍是完整参考：模型需要参数形状时才付这份预算。
    expect(doc).toMatch(/## Tool arguments/u);
  });
});
