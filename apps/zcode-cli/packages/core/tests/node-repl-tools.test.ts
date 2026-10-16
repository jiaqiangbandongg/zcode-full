import { describe, expect, it } from "vitest";
import {
  createJsToolEntry,
  jsToolEntry,
  disposeNodeReplSession,
} from "../src/tool/handlers/node-repl.js";
import { registerBuiltInTools } from "../src/tool/handlers/index.js";
import type { ToolExecutionContext } from "../src/tool/types.js";
import { JsInputJsonSchema, JsRuntimeInputSchema, type JsOutput } from "@zcode/contracts";

function ctx(sessionId: string): ToolExecutionContext {
  return {
    toolCallId: "tool_test",
    traceId: "trace_test",
    abortSignal: new AbortController().signal,
    workingDirectory: "/tmp",
    workspaceRoot: "/tmp",
    sessionId: sessionId as ToolExecutionContext["sessionId"],
  };
}

describe("node_repl tools", () => {
  it("js persists globalThis state across calls in the same session", async () => {
    const c = ctx("s1");
    await jsToolEntry.handler({ code: "globalThis.n = 10;" }, c);
    const out = (await jsToolEntry.handler({ code: "return globalThis.n + 5;" }, c)) as JsOutput;
    expect(out.error).toBeUndefined();
    expect(out.result).toBe("15");
    disposeNodeReplSession("s1" as ToolExecutionContext["sessionId"]);
  });

  it("isolates state between different sessions", async () => {
    await jsToolEntry.handler({ code: "globalThis.k = 'a';" }, ctx("sA"));
    const out = (await jsToolEntry.handler(
      { code: "return typeof globalThis.k;" },
      ctx("sB"),
    )) as JsOutput;
    expect(out.result).toBe("undefined");
    disposeNodeReplSession("sA" as ToolExecutionContext["sessionId"]);
    disposeNodeReplSession("sB" as ToolExecutionContext["sessionId"]);
  });

  it("js exposes timeout_ms/title schema and request/response metadata", async () => {
    const c = ctx("s-meta");
    const out = (await jsToolEntry.handler(
      {
        code: "nodeRepl.setResponseMeta({ panel: 'browser' }); return nodeRepl.requestMeta.title;",
        timeout_ms: 1000,
        title: "Inspect page",
      },
      c,
    )) as JsOutput;
    expect(out.result).toBe("Inspect page");
    expect(out.responseMeta).toEqual({ panel: "browser" });
    disposeNodeReplSession("s-meta" as ToolExecutionContext["sessionId"]);
  });

  it("requires a user title in the model contract while accepting legacy runtime input", () => {
    expect(JsInputJsonSchema.required).toEqual(expect.arrayContaining(["code", "title"]));
    expect(JsRuntimeInputSchema.safeParse({ code: "return 1;" }).success).toBe(true);
  });

  it("js returns structured error without throwing", async () => {
    const c = ctx("s4");
    const out = (await jsToolEntry.handler({ code: 'throw new Error("boom");' }, c)) as JsOutput;
    expect(out.error?.message).toBe("boom");
    disposeNodeReplSession("s4" as ToolExecutionContext["sessionId"]);
  });

  it("js 模型输出不重复 Error message，只追加 stack frames", () => {
    const content = jsToolEntry.formatModelContent?.({
      logs: "",
      error: {
        name: "Error",
        message: "Timeout waiting for locator\nlocator.fill failed for selector #search",
        stack:
          "Error: Timeout waiting for locator\nlocator.fill failed for selector #search\n    at click (browser.js:1:1)",
      },
    });

    expect(content).toBe(
      "Error: Timeout waiting for locator\nlocator.fill failed for selector #search\n    at click (browser.js:1:1)",
    );
    expect(String(content).match(/Timeout waiting for locator/g)).toHaveLength(1);
    expect(String(content).match(/locator\.fill failed/g)).toHaveLength(1);
  });

  it("registers node_repl tools only when includeNodeRepl is true", () => {
    const on: string[] = [];
    registerBuiltInTools(
      { register: (e) => on.push(e.metadata.name) },
      { includeNodeRepl: true, silentDuplicateWarnings: true },
    );
    expect(on).toContain("js");
    // 2026-09-18：js_reset 与 js_add_node_module_dir 连同 moduleDirs 能力一并删除，
    // node_repl 只保留 js。这里同时守住"不再注册"，避免旧 entry 被重新引入。
    expect(on).not.toContain("js_reset");
    expect(on).not.toContain("js_add_node_module_dir");

    const off: string[] = [];
    registerBuiltInTools(
      { register: (e) => off.push(e.metadata.name) },
      { silentDuplicateWarnings: true },
    );
    expect(off).not.toContain("js");
  });

  it("keeps browser guidance out of js metadata unless browser-use is enabled", () => {
    expect(createJsToolEntry().metadata.description).not.toContain("agent.browsers");
    const description = createJsToolEntry({ browserUseEnabled: true }).metadata.description;
    expect(description).toContain("agent.browsers");
    expect(description).toContain("opening a page is not a reason to capture a screenshot");
    expect(description).toContain("final expression");
    expect(description).toContain("agent.browsers.getForUrl(url)");
    expect(description).toContain("Never iterate guessed URL variants");
    expect(description).toContain("never write `evaluate()` code to rediscover");
    expect(description).toContain("execute JavaScript in the page context");
    expect(description).not.toContain("read-only evaluate");
    expect(description).not.toContain("Possible side-effect in debug-evaluate");
    expect(description).toContain("nodeRepl.emitImage(await tab.screenshot())");
    expect(description).toContain("never leave `tab.screenshot()` as the final expression");
    expect(description).toContain(
      "read `browser.tabs.list()` and `browser.user.openTabs()` unconditionally in the same observation cell",
    );
    expect(description).toContain(
      "Return `{ controlledTabs, userTabs }` as that cell's final result",
    );
  });
});
