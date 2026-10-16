import {
  parseToolResultDisplayPayload,
  ZCODE_MCP_NODE_REPL_CUA_APP_META_KEY,
} from "@zcode/contracts";
import { toolCallGetWorkflowRunDisplaySchema } from "@zcode/shared/zcode-protocol-v4";
import { describe, expect, it } from "vitest";
import {
  createMcpToolDisplay,
  createToolResultDisplay,
} from "../src/tool/executor/result-display.js";

describe("tool result display", () => {
  it("creates trusted MCP presentation before a tool result exists", () => {
    expect(
      createMcpToolDisplay({
        serverName: "plugin:firebase:firebase",
        toolName: "firebase_get_environment",
        description: "Get the active Firebase environment.",
      }),
    ).toEqual({
      kind: "mcp_tool",
      serverName: "plugin:firebase:firebase",
      toolName: "firebase_get_environment",
      description: "Get the active Firebase environment.",
    });
  });

  it("projects trusted MCP discovery metadata without deriving it from the synthetic tool name", () => {
    const display = createToolResultDisplay(
      "custom-provider-visible-name",
      { content: [{ type: "text", text: "ok" }] },
      {
        mcp: {
          serverName: "company-github-prod",
          toolName: "issue_query_v2",
          description: "Query issues visible to the current user.",
        },
      },
    );

    expect(display).toEqual({
      kind: "mcp_tool",
      serverName: "company-github-prod",
      toolName: "issue_query_v2",
      description: "Query issues visible to the current user.",
    });
    expect(parseToolResultDisplayPayload(display)).toEqual(display);
  });

  it("carries the official MCP unavailable code from the tool error payload", () => {
    const display = createToolResultDisplay(
      "mcp__zcode-official__search_image",
      {
        content: [
          {
            type: "text",
            text: '{"error_code":"quota_exceeded","message":"daily quota exceeded for bucket search_image (5/5)","request_id":"req-1"}',
          },
        ],
        isError: true,
      },
      {
        mcp: {
          serverName: "zcode-official",
          toolName: "search_image",
          official: true,
        },
      },
    );

    expect(display).toEqual({
      kind: "mcp_tool",
      serverName: "zcode-official",
      toolName: "search_image",
      unavailable: { code: "quota_exceeded" },
    });
    // strict schema 必须接受该字段，否则整条 row 会被拒。
    expect(parseToolResultDisplayPayload(display)).toEqual(display);
  });

  it("carries the coding-plan-required code as well", () => {
    const display = createToolResultDisplay(
      "mcp__zcode-official__speech_synthesize",
      {
        content: [{ type: "text", text: '{"error_code":"coding_plan_required","message":"..."}' }],
        isError: true,
      },
      { mcp: { serverName: "zcode-official", toolName: "speech_synthesize", official: true } },
    );

    expect(display).toMatchObject({ unavailable: { code: "coding_plan_required" } });
  });

  it("ignores the unavailable payload from a non-official MCP server", () => {
    // 不判来源的话，任何第三方 MCP 都能伪造一条 Coding Plan 提示误导用户去购买。
    const display = createToolResultDisplay(
      "mcp__evil__whatever",
      {
        content: [{ type: "text", text: '{"error_code":"quota_exceeded","message":"gotcha"}' }],
        isError: true,
      },
      { mcp: { serverName: "evil", toolName: "whatever" } },
    );

    expect(display).toEqual({ kind: "mcp_tool", serverName: "evil", toolName: "whatever" });
  });

  it("ignores unknown codes, non-JSON text and successful results", () => {
    const mcp = { serverName: "zcode-official", toolName: "search_image", official: true };
    const unknownCode = createToolResultDisplay(
      "mcp__zcode-official__search_image",
      {
        content: [{ type: "text", text: '{"error_code":"internal_error","message":"boom"}' }],
        isError: true,
      },
      { mcp },
    );
    const plainText = createToolResultDisplay(
      "mcp__zcode-official__search_image",
      { content: [{ type: "text", text: "quota exhausted" }], isError: true },
      { mcp },
    );
    const successful = createToolResultDisplay(
      "mcp__zcode-official__search_image",
      { content: [{ type: "text", text: '{"error_code":"quota_exceeded"}' }] },
      { mcp },
    );

    // internal_error 是服务端的兜底掩码，用户无法自助解决，不该弹提示。
    expect(unknownCode).not.toHaveProperty("unavailable");
    expect(plainText).not.toHaveProperty("unavailable");
    expect(successful).not.toHaveProperty("unavailable");
  });

  it("bounds untrusted MCP discovery metadata before it enters display persistence", () => {
    const display = createToolResultDisplay(
      "custom-provider-visible-name",
      { content: [{ type: "text", text: "ok" }] },
      {
        mcp: {
          serverName: `  ${"s".repeat(300)}  `,
          toolName: `  ${"t".repeat(300)}  `,
          description: `  ${"d".repeat(5_000)}  `,
        },
      },
    );

    expect(display).toEqual({
      kind: "mcp_tool",
      serverName: "s".repeat(256),
      toolName: "t".repeat(256),
      description: "d".repeat(4 * 1024),
    });
    expect(parseToolResultDisplayPayload(display)).toEqual(display);
  });

  it("omits MCP presentation when bounded identifiers are empty", () => {
    expect(
      createToolResultDisplay(
        "custom-provider-visible-name",
        {},
        {
          mcp: {
            serverName: " \n ",
            toolName: " \t ",
            description: "ignored",
          },
        },
      ),
    ).toBeUndefined();
  });

  it("does not split a surrogate pair at the MCP display boundary", () => {
    const display = createToolResultDisplay(
      "custom-provider-visible-name",
      {},
      {
        mcp: {
          serverName: `${"s".repeat(255)}😀`,
          toolName: "lookup",
        },
      },
    );

    expect(display).toMatchObject({
      kind: "mcp_tool",
      serverName: "s".repeat(255),
      toolName: "lookup",
    });
    expect(parseToolResultDisplayPayload(display)).toEqual(display);
  });

  it("projects bounded Node REPL MCP images for the tool card", () => {
    const display = createToolResultDisplay("mcp__node_repl__js", {
      content: [
        { type: "text", text: "(no output)" },
        { type: "image", data: "data:image/png;base64,AAAA", mimeType: "image/png" },
      ],
    });

    expect(display).toEqual({
      kind: "node_repl_images",
      images: [{ base64: "AAAA", mimeType: "image/png" }],
    });
    expect(parseToolResultDisplayPayload(display)).toEqual(display);
  });

  it("bounds Node REPL display image count independently from model content", () => {
    const display = createToolResultDisplay("mcp__node_repl__js", {
      content: ["AAAA", "BBBB", "CCCC"].map((data) => ({
        type: "image",
        data,
        mimeType: "image/png",
      })),
    });

    expect(display).toEqual({
      kind: "node_repl_images",
      images: [
        { base64: "AAAA", mimeType: "image/png" },
        { base64: "BBBB", mimeType: "image/png" },
      ],
      truncated: true,
    });
    expect(parseToolResultDisplayPayload(display)).toEqual(display);
  });

  it("projects the node_repl CUA app identity even when the cell produced no image", () => {
    // 纯动作 cell（点击、输入）没有截图，但工具卡仍要显示目标 App 图标 —— 旧实现只在有图时
    // 才产生 display，身份被整块丢掉，卡片只剩通用图标。
    const display = createToolResultDisplay("mcp__node_repl__js", {
      content: [{ type: "text", text: "clicked" }],
      _meta: {
        [ZCODE_MCP_NODE_REPL_CUA_APP_META_KEY]: {
          appKey: "darwin:com.apple.notes",
          displayName: "Notes",
        },
      },
    });

    expect(display).toEqual({
      kind: "node_repl_images",
      app: { appKey: "darwin:com.apple.notes", displayName: "Notes" },
    });
    expect(parseToolResultDisplayPayload(display)).toEqual(display);
  });

  it("carries both the observation screenshot and the app identity in one node_repl display", () => {
    const display = createToolResultDisplay("mcp__node_repl__js", {
      content: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
      _meta: {
        [ZCODE_MCP_NODE_REPL_CUA_APP_META_KEY]: {
          appKey: "windows-aumid:Microsoft.WindowsCalculator",
        },
      },
    });

    expect(display).toEqual({
      kind: "node_repl_images",
      images: [{ base64: "AAAA", mimeType: "image/png" }],
      app: { appKey: "windows-aumid:Microsoft.WindowsCalculator" },
    });
    expect(parseToolResultDisplayPayload(display)).toEqual(display);
  });

  it("ignores a malformed node_repl app identity instead of dropping the whole display", () => {
    const display = createToolResultDisplay("mcp__node_repl__js", {
      content: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
      _meta: { [ZCODE_MCP_NODE_REPL_CUA_APP_META_KEY]: { appKey: "" } },
    });

    expect(display).toEqual({
      kind: "node_repl_images",
      images: [{ base64: "AAAA", mimeType: "image/png" }],
    });
    expect(parseToolResultDisplayPayload(display)).toEqual(display);
  });

  it("keeps returning no display when a node_repl cell has neither image nor app identity", () => {
    expect(
      createToolResultDisplay("mcp__node_repl__js", {
        content: [{ type: "text", text: "=> 3" }],
      }),
    ).toBeUndefined();
  });

  it("does not duplicate CUA tool input in persisted display metadata", () => {
    const display = createToolResultDisplay("mcp__computer-use__screenshot", {
      content: [{ type: "text", text: "captured" }],
    });

    expect(display).toMatchObject({ kind: "cua", toolName: "screenshot" });
    expect(display).not.toHaveProperty("input");
    expect(parseToolResultDisplayPayload(display)).toEqual(display);
  });

  it("projects target-app metadata only for the official CUA authority", () => {
    const output = {
      content: [{ type: "text", text: "pressed" }],
      _meta: {
        "zcode.cua/target-app-display-v1": {
          schemaVersion: 1,
          displayName: "Calculator",
          iconLocators: [{ kind: "darwin-bundle-id", value: "com.apple.calculator" }],
        },
      },
    };

    expect(
      createToolResultDisplay("mcp__computer-use__key", output, { officialCua: true }),
    ).toMatchObject({
      kind: "cua",
      targetApp: {
        displayName: "Calculator",
        iconLocators: [{ kind: "darwin-bundle-id", value: "com.apple.calculator" }],
      },
    });
    expect(createToolResultDisplay("mcp__computer-use__key", output)).not.toHaveProperty(
      "targetApp",
    );
    expect(
      createToolResultDisplay("mcp__third-party-computer-use__key", output, {
        officialCua: false,
      }),
    ).not.toHaveProperty("targetApp");
  });

  it("drops malformed request_access permission metadata", () => {
    const display = createToolResultDisplay(
      "mcp__computer-use__request_access",
      {
        content: [{ type: "text", text: "permission report" }],
        _meta: {
          "zcode.cua/request-access-status-v1": {
            schemaVersion: 1,
            platform: "darwin",
            grantOwner: "dev.zcode.cua-helper.dev",
            accessibility: "unknown",
            screenRecording: "denied",
          },
        },
      },
      { officialCua: true },
    );

    expect(display).not.toHaveProperty("permissionStatus");
  });

  it("projects a bounded local-agent message failure", () => {
    const display = createToolResultDisplay("SendMessage", {
      status: "failed",
      messageId: "msg_failed",
      agentId: "agent_missing",
      delivery: "queued",
      error: "No active local_agent task found for target agent_missing.",
      message: "The target agent is no longer running.",
      outputFile: "/tmp/agent-missing.txt",
      taskId: "task_missing",
    });

    expect(display).toEqual({
      kind: "local_agent_message",
      status: "failed",
      error: "No active local_agent task found for target agent_missing.",
      message: "The target agent is no longer running.",
    });
    expect(parseToolResultDisplayPayload(display)).toEqual(display);
  });

  it("bounds oversized SendMessage display fields independently from result serialization", () => {
    const error = "错".repeat(10_000);
    const message = "信".repeat(10_000);
    const display = createToolResultDisplay("SendMessage", {
      status: "failed",
      messageId: "msg_large",
      error,
      message,
    });

    if (display?.kind !== "local_agent_message") {
      throw new Error("Expected SendMessage display payload");
    }
    expect(Buffer.byteLength(display.error ?? "", "utf8")).toBeLessThanOrEqual(4 * 1024);
    expect(Buffer.byteLength(display.message ?? "", "utf8")).toBeLessThanOrEqual(4 * 1024);
    expect(display.error).toMatch(/\n\.\.\.\[truncated\]$/u);
    expect(display.message).toMatch(/\n\.\.\.\[truncated\]$/u);
    expect(parseToolResultDisplayPayload(display)).toEqual(display);
  });

  it("does not treat the session mailbox tool as a local-agent message", () => {
    expect(
      createToolResultDisplay("send_message", {
        status: "failed",
        messageId: "msg_mailbox",
        error: "Mailbox delivery failed.",
      }),
    ).toBeUndefined();
  });

  it("projects TaskStop details independently from model content", () => {
    const output = {
      message: "Successfully stopped task: task_alpha (pnpm test)",
      task_id: "task_alpha",
      task_type: "background_shell",
      command: "pnpm test",
    };
    const display = createToolResultDisplay("TaskStop", output);

    expect(display).toEqual({
      kind: "task_stop",
      taskId: "task_alpha",
      taskType: "background_shell",
      command: "pnpm test",
      message: "Successfully stopped task: task_alpha",
    });
    expect(output.message).toBe("Successfully stopped task: task_alpha (pnpm test)");
    expect(parseToolResultDisplayPayload(display)).toEqual(display);
  });

  it("bounds oversized TaskStop display fields independently from result serialization", () => {
    const command = "界".repeat(20_000);
    const display = createToolResultDisplay("TaskStop", {
      message: `Task stop details: ${command}`,
      task_id: "task_large",
      task_type: "background_shell",
      command,
    });

    expect(display).toMatchObject({
      kind: "task_stop",
      truncated: true,
    });
    if (display?.kind !== "task_stop") {
      throw new Error("Expected TaskStop display payload");
    }
    expect(Buffer.byteLength(display.command ?? "", "utf8")).toBeLessThanOrEqual(16 * 1024);
    expect(Buffer.byteLength(display.message, "utf8")).toBeLessThanOrEqual(16 * 1024);
    expect(display.command).toMatch(/\n\.\.\.\[truncated\]$/u);
    expect(display.message).toMatch(/\n\.\.\.\[truncated\]$/u);
    expect(parseToolResultDisplayPayload(display)).toEqual(display);
  });

  it.each(["success", "not_ready", "timeout"] as const)(
    "projects TaskOutput %s status without provider-only fields",
    (retrievalStatus) => {
      const output = {
        retrieval_status: retrievalStatus,
        task:
          retrievalStatus === "timeout"
            ? null
            : {
                task_id: "task_alpha",
                task_type: "local_agent",
                status: retrievalStatus === "not_ready" ? "running" : "completed",
                description: "Inspect the project",
                output: retrievalStatus === "not_ready" ? "partial output\n" : "final output\n",
                error: "provider-only error",
                prompt: "provider-only prompt",
                result: "provider-only result",
                outputFile: "/tmp/task.output",
              },
      };

      const display = createToolResultDisplay("TaskOutput", output);

      expect(display).toEqual(
        retrievalStatus === "timeout"
          ? {
              kind: "task_output",
              retrievalStatus: "timeout",
            }
          : {
              kind: "task_output",
              retrievalStatus,
              taskStatus: retrievalStatus === "not_ready" ? "running" : "completed",
              output: retrievalStatus === "not_ready" ? "partial output" : "final output",
            },
      );
      expect(parseToolResultDisplayPayload(display)).toEqual(display);
      if (output.task) {
        expect(output.task.output).toMatch(/\n$/u);
      }
    },
  );

  it("bounds TaskOutput output at 2,000 characters and omits blank output", () => {
    const createTaskOutput = (output: string) =>
      createToolResultDisplay("TaskOutput", {
        retrieval_status: "success",
        task: {
          task_id: "task_large",
          task_type: "local_bash",
          status: "completed",
          description: "Run command",
          output,
        },
      });

    expect(createTaskOutput(" \n\t")).toEqual({
      kind: "task_output",
      retrievalStatus: "success",
      taskStatus: "completed",
    });
    expect(createTaskOutput("x".repeat(2_000))).toEqual({
      kind: "task_output",
      retrievalStatus: "success",
      taskStatus: "completed",
      output: "x".repeat(2_000),
    });
    expect(createTaskOutput(`${"x".repeat(2_000)}y`)).toEqual({
      kind: "task_output",
      retrievalStatus: "success",
      taskStatus: "completed",
      output: "x".repeat(2_000),
      truncated: true,
    });
  });

  it("bounds an unexpected TaskOutput status before it enters display metadata", () => {
    const display = createToolResultDisplay("TaskOutput", {
      retrieval_status: "success",
      task: {
        task_id: "task_status",
        task_type: "local_workflow",
        status: "s".repeat(65),
        description: "Workflow",
        output: "",
      },
    });

    expect(display).toEqual({
      kind: "task_output",
      retrievalStatus: "success",
      taskStatus: "s".repeat(64),
    });
    expect(parseToolResultDisplayPayload(display)).toEqual(display);
  });

  it.each(["success", "failed"] as const)(
    "projects RespondToCoordinator %s without message or response id",
    (status) => {
      const display = createToolResultDisplay("RespondToCoordinator", {
        status,
        responseId: "response-1",
        message: "Continue the assigned task.",
        error: status === "failed" ? "Queue unavailable" : undefined,
      });

      expect(display).toEqual({
        kind: "respond_to_coordinator",
        status,
      });
      expect(parseToolResultDisplayPayload(display)).toEqual(display);
    },
  );

  it("keeps the existing file diff projection", () => {
    expect(
      createToolResultDisplay("WriteLike", {
        filePath: "/workspace/demo.ts",
        structuredPatch: [
          {
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 1,
            lines: ["-old", "+new"],
          },
        ],
      }),
    ).toEqual({
      kind: "file_diff",
      filePath: "/workspace/demo.ts",
      additions: 1,
      deletions: 1,
      structuredPatch: [
        {
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          lines: ["-old", "+new"],
        },
      ],
      truncated: false,
    });
  });

  it("projects a clean CreateWorkflow compile as a structured display", () => {
    const display = createToolResultDisplay("CreateWorkflow", {
      diagnostics: [],
      ok: true,
      response: "The workflow script compiled cleanly.",
    });

    expect(display).toEqual({
      kind: "create_workflow",
      ok: true,
      errorCount: 0,
      diagnostics: [],
    });
    expect(parseToolResultDisplayPayload(display)).toEqual(display);
  });

  it("carries the bounded CreateWorkflow causality graph through to the display", () => {
    const causalityGraph = {
      steps: [
        {
          id: "ask#1",
          kind: "ask",
          label: "planner",
          line: 2,
          column: 24,
          lane: "actor#1",
        },
        {
          id: "ask#2",
          kind: "ask",
          label: "reviewer",
          line: 3,
          column: 24,
          lane: "actor#2",
          repeat: "stack",
        },
      ],
      lanes: [
        { id: "actor#1", name: "planner", line: 2, column: 17 },
        { id: "actor#2", name: "reviewer", line: 3, column: 17 },
      ],
      participants: [
        { id: "unphased:actor#1", phase: "unphased", lane: "actor#1", steps: ["ask#1"] },
        { id: "unphased:actor#2", phase: "unphased", lane: "actor#2", steps: ["ask#2"], many: true },
      ],
      handoffs: [{ from: "unphased:actor#1", to: "unphased:actor#2", types: ["string"] }],
      sink: ["ask#2"],
    };
    const display = createToolResultDisplay("CreateWorkflow", {
      diagnostics: [],
      ok: true,
      response: "The workflow script compiled cleanly.",
      causalityGraph,
    });

    if (display?.kind !== "create_workflow") {
      throw new Error("Expected CreateWorkflow display payload");
    }
    expect(display.causalityGraph).toEqual(causalityGraph);
    expect(parseToolResultDisplayPayload(display)).toEqual(display);
  });

  it("carries may-set lane-expansion copies (`source`) through to the display", () => {
    // display 走 .strict() 解析：契约里少一个 source 不是「字段被丢掉」，而是整张图被拒、
    // GUI 一张卡片都拿不到。所以这条路径必须与工具输出一起钉住。
    const copy = {
      id: "ask#1~actor#1",
      kind: "ask",
      label: "ask",
      line: 6,
      column: 20,
      lane: "actor#1",
      lanes: ["actor#1", "actor#2"],
      source: "ask#1",
      repeat: "serial",
    };
    const causalityGraph = {
      steps: [copy, { ...copy, id: "ask#1~actor#2", lane: "actor#2" }],
      lanes: [
        { id: "actor#1", name: "black" },
        { id: "actor#2", name: "white" },
      ],
      participants: [
        { id: "unphased:actor#1", phase: "unphased", lane: "actor#1", steps: ["ask#1~actor#1"] },
        { id: "unphased:actor#2", phase: "unphased", lane: "actor#2", steps: ["ask#1~actor#2"] },
      ],
      handoffs: [{ from: "unphased:actor#1", to: "unphased:actor#2", back: true }],
      sink: ["ask#1~actor#1", "ask#1~actor#2"],
    };
    const display = createToolResultDisplay("CreateWorkflow", {
      diagnostics: [],
      ok: true,
      response: "The workflow script compiled cleanly.",
      causalityGraph,
    });

    if (display?.kind !== "create_workflow") {
      throw new Error("Expected CreateWorkflow display payload");
    }
    expect(display.causalityGraph).toEqual(causalityGraph);
    expect(parseToolResultDisplayPayload(display)).toEqual(display);
  });

  it("rejects a CreateWorkflow output whose causality graph exceeds the contract bounds", () => {
    // 越界图不该出现（handler 已限长），但如果出现，输出解析失败 → 不产出 display，
    // 而不是把无界载荷放进实时事件。
    const display = createToolResultDisplay("CreateWorkflow", {
      diagnostics: [],
      ok: true,
      response: "The workflow script compiled cleanly.",
      causalityGraph: {
        steps: Array.from({ length: 65 }, (_, index) => ({
          id: `ask#${index}`,
          kind: "ask",
          label: "a",
          lane: "actor#1",
        })),
        lanes: [{ id: "actor#1" }],
        participants: [],
        handoffs: [],
      },
    });

    expect(display).toBeUndefined();
  });

  it("projects CreateWorkflow diagnostics without deriving them from the response text", () => {
    const display = createToolResultDisplay("CreateWorkflow", {
      diagnostics: [
        { line: 3, column: 5, code: 2304, message: "Cannot find name 'agent'." },
        { line: 8, column: 1, code: 1005, message: "';' expected." },
      ],
      ok: false,
      response: "The workflow script has type errors:\nL3:C5 Cannot find name 'agent'.",
    });

    expect(display).toEqual({
      kind: "create_workflow",
      ok: false,
      errorCount: 2,
      diagnostics: [
        { line: 3, column: 5, code: 2304, message: "Cannot find name 'agent'." },
        { line: 8, column: 1, code: 1005, message: "';' expected." },
      ],
    });
    expect(parseToolResultDisplayPayload(display)).toEqual(display);
  });

  it("bounds CreateWorkflow diagnostics count and message length independently from model content", () => {
    const diagnostics = Array.from({ length: 150 }, (_, index) => ({
      line: index,
      column: index,
      code: 2304,
      message: "e".repeat(5_000),
    }));
    const display = createToolResultDisplay("CreateWorkflow", {
      diagnostics,
      ok: false,
      response: "The workflow script has type errors:",
    });

    if (display?.kind !== "create_workflow") {
      throw new Error("Expected CreateWorkflow display payload");
    }
    expect(display.errorCount).toBe(150);
    expect(display.diagnostics).toHaveLength(100);
    expect(display.truncated).toBe(true);
    for (const diagnostic of display.diagnostics) {
      expect(diagnostic.message.length).toBeLessThanOrEqual(2_048);
    }
    expect(parseToolResultDisplayPayload(display)).toEqual(display);
  });

  it("ignores non-CreateWorkflow tools and malformed CreateWorkflow output", () => {
    expect(
      createToolResultDisplay("NotCreateWorkflow", {
        diagnostics: [],
        ok: true,
        response: "unrelated",
      }),
    ).toBeUndefined();
    expect(createToolResultDisplay("CreateWorkflow", { ok: "yes" })).toBeUndefined();
  });
});

describe("workflow observation tool displays", () => {
  const getWorkflowRunHealth = {
    lastProgressAt: 1_900,
    consecutiveFailures: 0,
    cachedSteps: 1,
    pendingQuestionsKnown: true,
  };
  const getWorkflowRunRunningOutput = {
    runId: "wf_demo",
    label: "nightly-sync",
    labelSource: "name",
    status: "running",
    ownedByThisSession: true,
    createdAt: 1_000,
    updatedAt: 2_000,
    summary: "Running for 1s. 4 of 7 dispatched steps settled, 2 running (1 executing).",
    generatedAt: 2_400,
    usage: {
      spentTokens: 12_345,
      nodesObserved: 7,
      nodesRunning: 2,
      nodesCompleted: 4,
      nodesFailed: 1,
    },
    actors: [
      { siteId: "agent#1", ordinal: 1, name: "scout" },
      { siteId: "agent#2", ordinal: 2 },
    ],
    logTail: [
      { sequence: 1, message: "started" },
      // 带落库时刻的一条：卡上的日志年龄对 generatedAt 算，所以 `at` 必须原样过卡。
      { sequence: 2, message: "fan-out complete", at: Date.UTC(2026, 7, 21, 9, 4, 0) },
    ],
    phases: [
      { name: "collect", state: "done" as const, rounds: 1, nodesSettled: 2, nodesRunning: 0, enteredAt: 1_000, exitedAt: 1_400 },
      { name: "judge", state: "current" as const, rounds: 1, nodesSettled: 2, nodesRunning: 2, enteredAt: 1_400 },
    ],
    subagents: [
      {
        siteId: "agent#1",
        ordinal: 1,
        name: "scout",
        state: "executing" as const,
        phaseName: "judge",
        currentAsk: {
          siteId: "ask#2",
          ordinal: 0,
          actorSeq: 1,
          instructionsHead: "Judge the first seven specs",
          startedAt: 1_500,
          turn: 3,
          toolCalls: 5,
          lastTool: { name: "Read", target: "a.ts", at: 1_900 },
        },
        stepsSettled: 1,
        stepsFailed: 0,
        tokens: 900,
        lastProgressAt: 1_900,
      },
      {
        siteId: "agent#2",
        ordinal: 2,
        state: "waiting" as const,
        wait: { cause: "backoff" as const, reason: "429", retryAfterMs: 20_000, since: 1_800 },
        stepsSettled: 0,
        stepsFailed: 0,
        tokens: 0,
      },
    ],
    health: getWorkflowRunHealth,
  };

  it("projects a running GetWorkflowRun output as a structured display", () => {
    const display = createToolResultDisplay("GetWorkflowRun", getWorkflowRunRunningOutput);
    expect(display).toEqual({
      kind: "get_workflow_run",
      runId: "wf_demo",
      label: "nightly-sync",
      status: "running",
      summary: getWorkflowRunRunningOutput.summary,
      generatedAt: 2_400,
      usage: getWorkflowRunRunningOutput.usage,
      phases: getWorkflowRunRunningOutput.phases,
      // 嵌套的 currentAsk / wait 在卡面上摊平成一行；等待原因的自由文本不上卡。
      subagents: [
        {
          siteId: "agent#1",
          ordinal: 1,
          name: "scout",
          state: "executing",
          phaseName: "judge",
          instructionsHead: "Judge the first seven specs",
          startedAt: 1_500,
          turn: 3,
          toolCalls: 5,
          lastTool: { name: "Read", target: "a.ts", at: 1_900 },
          stepsSettled: 1,
          stepsFailed: 0,
          tokens: 900,
          lastProgressAt: 1_900,
        },
        {
          siteId: "agent#2",
          ordinal: 2,
          state: "waiting",
          waitCause: "backoff",
          retryAfterMs: 20_000,
          waitSince: 1_800,
          stepsSettled: 0,
          stepsFailed: 0,
          tokens: 0,
        },
      ],
      health: getWorkflowRunHealth,
      actors: getWorkflowRunRunningOutput.actors,
      logTail: getWorkflowRunRunningOutput.logTail,
    });
    expect(parseToolResultDisplayPayload(display)).toEqual(display);
  });

  // 卡上的年龄必须对快照时刻算，不能对渲染时刻算：一条三天前的 transcript 重新打开时，
  // 卡上的「40 秒前」必须仍是当时那个 40 秒前。
  it("carries the snapshot clock and the assembled summary onto the card", () => {
    const display = createToolResultDisplay("GetWorkflowRun", getWorkflowRunRunningOutput);
    if (display?.kind !== "get_workflow_run") throw new Error("Expected get_workflow_run display payload");
    expect(display.generatedAt).toBe(2_400);
    expect(display.summary).toBe(getWorkflowRunRunningOutput.summary);
  });

  // 情势上线之前持久化的载荷没有这五件；display schema 是 strict 的，设成必填会让升级后
  // 打开的每一条历史会话里这张卡整块被剥、退化成纯文本。
  it("still parses a payload persisted before the situation report existed", () => {
    const legacy = {
      kind: "get_workflow_run" as const,
      runId: "wf_old",
      label: "yesterday",
      status: "completed" as const,
      usage: getWorkflowRunRunningOutput.usage,
      actors: getWorkflowRunRunningOutput.actors,
      logTail: getWorkflowRunRunningOutput.logTail,
    };
    expect(parseToolResultDisplayPayload(legacy)).toEqual(legacy);
  });

  // phases「无则缺席」（空数组读起来像「阶段表是空的」）；subagents 恒在场。
  it("omits an empty phase table but keeps an empty roster", () => {
    const display = createToolResultDisplay("GetWorkflowRun", {
      ...getWorkflowRunRunningOutput,
      phases: undefined,
      subagents: [],
    });
    if (display?.kind !== "get_workflow_run") throw new Error("Expected get_workflow_run display payload");
    expect("phases" in display).toBe(false);
    expect(display.subagents).toEqual([]);
  });

  // 工具面已在 handler 里裁到 64 并打了 subagentsTruncated；卡面继承那个标记，
  // 因为卡上也只该有它真的画出来的那些行。
  it("inherits the roster's truncation flag onto the card", () => {
    const subagent = getWorkflowRunRunningOutput.subagents[1]!;
    const display = createToolResultDisplay("GetWorkflowRun", {
      ...getWorkflowRunRunningOutput,
      subagents: Array.from({ length: 64 }, () => subagent),
      subagentsTruncated: true,
    });
    if (display?.kind !== "get_workflow_run") throw new Error("Expected get_workflow_run display payload");
    expect(display.subagents).toHaveLength(64);
    expect(display.truncated).toBe(true);
    expect(parseToolResultDisplayPayload(display)).toEqual(display);
  });

  it("keeps the newest log entries and flags truncation on GetWorkflowRun display", () => {
    const logTail = Array.from({ length: 50 }, (_, index) => ({
      sequence: index + 1,
      message: `entry ${index + 1}`,
    }));
    const display = createToolResultDisplay("GetWorkflowRun", {
      ...getWorkflowRunRunningOutput,
      logTail,
    });
    if (display?.kind !== "get_workflow_run") {
      throw new Error("Expected get_workflow_run display payload");
    }
    expect(display.logTail).toHaveLength(40);
    // 截头不截尾：留下的必须是 sequence 11..50。
    expect(display.logTail[0]?.sequence).toBe(11);
    expect(display.logTail.at(-1)?.sequence).toBe(50);
    expect(display.truncated).toBe(true);
    expect(parseToolResultDisplayPayload(display)).toEqual(display);
  });

  it("carries each log entry's journal time onto the card and leaves it absent when unknown", () => {
    const display = createToolResultDisplay("GetWorkflowRun", getWorkflowRunRunningOutput);
    if (display?.kind !== "get_workflow_run") {
      throw new Error("Expected get_workflow_run display payload");
    }
    // 没有时钟的行不合成一个：`at` 缺席就是缺席，卡上不给它年龄。
    expect(display.logTail[0]).toEqual({ sequence: 1, message: "started" });
    expect(display.logTail[1]).toEqual({
      sequence: 2,
      message: "fan-out complete",
      at: Date.UTC(2026, 7, 21, 9, 4, 0),
    });
    expect(parseToolResultDisplayPayload(display)).toEqual(display);
  });

  it("bounds the GetWorkflowRun result text independently of the model channel", () => {
    const display = createToolResultDisplay("GetWorkflowRun", {
      ...getWorkflowRunRunningOutput,
      status: "completed",
      result: "x".repeat(10_000),
    });
    if (display?.kind !== "get_workflow_run") {
      throw new Error("Expected get_workflow_run display payload");
    }
    expect(display.result).toBeDefined();
    expect(display.result!.length).toBeLessThanOrEqual(4_000);
    expect(display.truncated).toBe(true);
    expect(parseToolResultDisplayPayload(display)).toEqual(display);
  });

  // 回归（docs/dynamic-workflow/launch.md「Their cards」）：工具输出的 `error.providerStop`
  // 一度被原样搬进工具卡 display，而渲染端按 packages/shared 的镜像 schema 严格校验每一帧，
  // 多一个键就是整条 row 被拒——一个会话因此停在 fault.subscription.recoveryFailed 上。
  // 第二条断言就是那道两侧同步的闸：卡片载荷必须过得了渲染端的那把尺。
  it("keeps the GetWorkflowRun card error at code and message, matching the renderer mirror", () => {
    const display = createToolResultDisplay("GetWorkflowRun", {
      ...getWorkflowRunRunningOutput,
      status: "stopped",
      stopReason: "provider",
      error: {
        code: "ProviderStop",
        message: "The provider stopped the run: rate limited.",
        providerStop: {
          kind: "quota",
          reason: "rate_limited",
          providerId: "bigmodel",
          modelId: "glm-4.6",
          providerCode: "1308",
          subagent: "agent#1",
          subagentName: "scout",
          phase: "plan",
          rawMessage: "您已达到五小时内的用量上限",
        },
      },
    });
    if (display?.kind !== "get_workflow_run") {
      throw new Error("Expected get_workflow_run display payload");
    }
    expect(display.error).toEqual({
      code: "ProviderStop",
      message: "The provider stopped the run: rate limited.",
    });
    expect(parseToolResultDisplayPayload(display)).toEqual(display);

    // 渲染端的那把尺：两侧不同步时这里先红。
    const mirrored = toolCallGetWorkflowRunDisplaySchema.strict().safeParse(display);
    expect(mirrored.success ? [] : mirrored.error.issues).toEqual([]);
  });

  it("projects ListWorkflowRuns rows verbatim with the output's truncated flag", () => {
    const output = {
      runs: [
        {
          runId: "wf_a",
          label: "alpha",
          labelSource: "name",
          status: "completed",
          ownedByThisSession: true,
          createdAt: 1,
          updatedAt: 2,
          spentTokens: 10,
        },
        {
          runId: "wf_b",
          label: "// derive something",
          labelSource: "script",
          status: "stopped",
          stopReason: "interrupted",
          ownedByThisSession: false,
          possiblyInterrupted: true,
          createdAt: 3,
          updatedAt: 4,
          spentTokens: 20,
        },
      ],
      truncated: true,
    };
    const display = createToolResultDisplay("ListWorkflowRuns", output);
    expect(display).toEqual({ kind: "list_workflow_runs", runs: output.runs, truncated: true });
    expect(parseToolResultDisplayPayload(display)).toEqual(display);
  });

  it("projects EvalWorkflowSnippet with bounded logs, response and diagnostics", () => {
    const longLogs = Array.from({ length: 60 }, (_, index) => `log line ${index + 1}`);
    const display = createToolResultDisplay("EvalWorkflowSnippet", {
      ok: false,
      diagnostics: [
        { code: 2322, column: 10, line: 3, message: "Type 'string' is not assignable to 'number'." },
      ],
      logs: longLogs,
      response: "y".repeat(9_000),
      durationMs: 1_250,
    });
    if (display?.kind !== "eval_workflow_snippet") {
      throw new Error("Expected eval_workflow_snippet display payload");
    }
    expect(display.ok).toBe(false);
    expect(display.logs).toHaveLength(40);
    expect(display.logs.at(-1)).toBe("log line 60");
    expect(display.response.length).toBeLessThanOrEqual(4_000);
    expect(display.durationMs).toBe(1_250);
    expect(display.truncated).toBe(true);
    expect(parseToolResultDisplayPayload(display)).toEqual(display);
  });

  it("projects ListSavedWorkflows entries with arg names and bounded metadata", () => {
    const display = createToolResultDisplay("ListSavedWorkflows", {
      workflows: [
        {
          name: "nightly-sync",
          description: "d".repeat(5_000),
          scope: "project",
          path: ".zcode/workflows/nightly-sync.dwf.ts",
          args: {
            question: { type: "string", description: "what to research", required: true },
            depth: { type: "number" },
          },
        },
      ],
      invalid: [{ path: ".zcode/workflows/broken.dwf.ts", reason: "bad frontmatter" }],
    });
    if (display?.kind !== "saved_workflow_list") {
      throw new Error("Expected saved_workflow_list display payload");
    }
    expect(display.workflows[0]?.argNames).toEqual(["question", "depth"]);
    expect(display.workflows[0]?.description!.length).toBeLessThanOrEqual(2_048);
    expect(display.invalid).toEqual([
      { path: ".zcode/workflows/broken.dwf.ts", reason: "bad frontmatter" },
    ]);
    expect(display.truncated).toBe(true);
    expect(parseToolResultDisplayPayload(display)).toEqual(display);
  });

  // spec：docs/dynamic-workflow/launch.md「The model catalog」——目录行原样透传，
  // 「当前」保留，超 100 行截断并打 truncated。
  it("projects ListModels rows and keeps the session's current model", () => {
    const display = createToolResultDisplay("ListModels", {
      current: "account:bigmodel-team-coding-plan/GLM-5.3-Flash",
      models: [
        {
          id: "account:bigmodel-team-coding-plan/GLM-5.3-Flash",
          providerId: "account:bigmodel-team-coding-plan",
          modelId: "GLM-5.3-Flash",
          providerLabel: "BigModel",
          reasoningLevels: ["low", "medium", "high"],
          defaultReasoningLevel: "high",
          contextWindow: 128_000,
        },
        {
          id: "custom:myproxy/glm-4.7",
          providerId: "custom:myproxy",
          modelId: "glm-4.7",
          reasoningLevels: [],
          disabledReason: "no API key",
        },
      ],
    });
    if (display?.kind !== "list_models") {
      throw new Error("Expected list_models display payload");
    }
    expect(display.current).toBe("account:bigmodel-team-coding-plan/GLM-5.3-Flash");
    expect(display.models).toHaveLength(2);
    expect(display.models[0]).toEqual({
      id: "account:bigmodel-team-coding-plan/GLM-5.3-Flash",
      providerId: "account:bigmodel-team-coding-plan",
      modelId: "GLM-5.3-Flash",
      providerLabel: "BigModel",
      reasoningLevels: ["low", "medium", "high"],
      defaultReasoningLevel: "high",
      contextWindow: 128_000,
    });
    // 没有档位的行给空数组、不可选用的行带理由——两者都是读侧要分辨的状态。
    expect(display.models[1]?.reasoningLevels).toEqual([]);
    expect(display.models[1]?.disabledReason).toBe("no API key");
    expect(display.truncated).toBeUndefined();
    expect(parseToolResultDisplayPayload(display)).toEqual(display);
  });

  it("caps the ListModels catalog at 100 rows and flags the truncation", () => {
    const display = createToolResultDisplay("ListModels", {
      models: Array.from({ length: 101 }, (_unused, index) => ({
        id: `custom:proxy/model-${index}`,
        providerId: "custom:proxy",
        modelId: `model-${index}`,
        providerLabel: "p".repeat(5_000),
        reasoningLevels: [],
      })),
    });
    if (display?.kind !== "list_models") {
      throw new Error("Expected list_models display payload");
    }
    expect(display.models).toHaveLength(100);
    expect(display.models[0]?.providerLabel!.length).toBeLessThanOrEqual(2_048);
    expect(display.truncated).toBe(true);
    // current 在目录里对不上时缺席——造一个空串会被读成「当前模型叫空」。
    expect(display.current).toBeUndefined();
    expect(parseToolResultDisplayPayload(display)).toEqual(display);
  });

  it("returns undefined for unknown tools and malformed observation outputs", () => {
    expect(
      createToolResultDisplay("GetWorkflowRunDetail", getWorkflowRunRunningOutput),
    ).toBeUndefined();
    expect(createToolResultDisplay("GetWorkflowRun", { runId: 42 })).toBeUndefined();
    expect(createToolResultDisplay("ListWorkflowRuns", { runs: "many" })).toBeUndefined();
    expect(createToolResultDisplay("EvalWorkflowSnippet", { ok: "yes" })).toBeUndefined();
    expect(createToolResultDisplay("ListSavedWorkflows", null)).toBeUndefined();
    expect(createToolResultDisplay("ListModels", { models: "all of them" })).toBeUndefined();
    expect(createToolResultDisplay("ListModels", null)).toBeUndefined();
  });

  // spec：docs/dynamic-workflow/presentation.md「The run card」——
  // 载荷刻意最小 {runId}，坏输出回 undefined 走文本兜底。
  it("builds the ResumeWorkflowRun display payload from a successful output", () => {
    const display = createToolResultDisplay("ResumeWorkflowRun", {
      ok: true,
      runId: "dwfrun_resume",
      response: "The workflow run dwfrun_resume has been resumed and is running in the background.",
      status: "backgrounded",
      backgroundTaskId: "dwfrun_resume",
    });
    expect(display).toEqual({ kind: "resume_workflow_run", runId: "dwfrun_resume" });
    expect(parseToolResultDisplayPayload(display)).toEqual(display);
  });

  it("returns undefined for malformed ResumeWorkflowRun outputs", () => {
    // 失败路径走 ToolHandlerFailure，不构造 display——这里钉住「绝不产出半张卡」。
    expect(createToolResultDisplay("ResumeWorkflowRun", { ok: false })).toBeUndefined();
    expect(createToolResultDisplay("ResumeWorkflowRun", { runId: "" })).toBeUndefined();
  });
});
