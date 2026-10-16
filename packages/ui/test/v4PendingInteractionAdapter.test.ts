import { permissionRequestPayloadSchema } from "@zcode/shared/zcode-protocol-v4";
import { describe, expect, it } from "vitest";
import {
  pendingUserInputToElicitationRequest,
  pendingPermissionToLegacyRequest,
  pendingUserInputToViewModel,
} from "@/v4/pendingInteractionAdapter.js";

describe("pendingInteractionAdapter", () => {
  it("PA158 仅完整能力声明增加完全访问；旧协议解析忽略新字段", () => {
    const payload = {
      kind: "permission" as const,
      toolCallId: "t",
      toolName: "Bash",
      summary: "permission",
      detail: { command: "pwd" },
      options: [{ optionId: "allowOnce", label: "Allow once", kind: "allowOnce" as const }],
      fullAccessOption: {
        optionId: "fullAccess" as const,
        label: "Full access",
        kind: "custom" as const,
        response: { decision: "deny" as const },
      },
    };
    const interaction = {
      interactionId: "p",
      kind: "permission" as const,
      anchorRowId: null,
      createdAt: 1,
      payload,
    };
    const request = pendingPermissionToLegacyRequest("s", interaction);
    expect(request.options.at(-1)).toMatchObject({
      optionId: "fullAccess",
      response: { decision: "deny" },
    });
    const legacySchema = permissionRequestPayloadSchema.omit({ fullAccessOption: true });
    const legacy = legacySchema.parse(payload);
    expect(legacy).not.toHaveProperty("fullAccessOption");
    expect(
      pendingPermissionToLegacyRequest("s", { ...interaction, payload: legacy }).options,
    ).toHaveLength(1);
  });
  it("maps v4 permission interaction to legacy PermissionDialog request", () => {
    const request = pendingPermissionToLegacyRequest("sess-1", {
      interactionId: "perm-1",
      kind: "permission",
      anchorRowId: 3,
      createdAt: 100,
      payload: {
        kind: "permission",
        toolCallId: "tc-1",
        toolName: "Bash",
        summary: "Run ls",
        detail: { command: "ls" },
        freeText: true,
        origin: {
          kind: "subagent",
          agentId: "agent-child",
          agentType: "general-purpose",
          childSessionId: "sess-child",
          parentSessionId: "sess-1",
          parentToolCallId: "tool-parent-agent",
        },
        options: [
          { optionId: "allow", label: "Allow", kind: "allowOnce" },
          { optionId: "deny", label: "Deny", kind: "deny" },
        ],
      },
    });

    expect(request.requestId).toBe("perm-1");
    expect(request.taskId).toBe("sess-1");
    expect(request.options).toHaveLength(2);
    expect(request.options[0]?.response).toEqual({ decision: "allow" });
    expect(request.options[1]?.response).toEqual({ decision: "deny" });
    expect(request.freeText).toBe(true);
    expect(request.origin).toMatchObject({
      kind: "subagent",
      agentType: "general-purpose",
      childSessionId: "sess-child",
      parentSessionId: "sess-1",
      parentToolCallId: "tool-parent-agent",
    });
  });

  it("preserves the original v4 permission option response", () => {
    const response = {
      decision: "allow" as const,
      permissionUpdates: [
        {
          behavior: "allow" as const,
          rules: [{ ruleContent: "pnpm run lint:*", toolName: "Bash" }],
          type: "addRules" as const,
        },
      ],
    };
    const request = pendingPermissionToLegacyRequest("sess-1", {
      interactionId: "perm-prefix",
      kind: "permission",
      anchorRowId: null,
      createdAt: 100,
      payload: {
        kind: "permission",
        toolCallId: "tc-prefix",
        toolName: "Bash",
        summary: "Run lint",
        detail: { command: "pnpm run lint --fix" },
        options: [
          {
            optionId: "allowAlways",
            label: "Always allow",
            kind: "allowAlways",
            response,
          },
        ],
      },
    });

    expect(request.options[0]?.response).toEqual(response);
  });

  it("generates an exact project rule for a legacy v4 option without response", () => {
    const request = pendingPermissionToLegacyRequest("sess-1", {
      interactionId: "perm-legacy-always",
      kind: "permission",
      anchorRowId: null,
      createdAt: 100,
      payload: {
        kind: "permission",
        toolCallId: "tc-legacy-always",
        toolName: "Bash",
        summary: "Run lint",
        detail: { command: "pnpm run lint --fix" },
        options: [
          {
            optionId: "allowAlways",
            label: "Always allow",
            kind: "allowAlways",
          },
        ],
      },
    });

    expect(request.options[0]?.response).toEqual({
      decision: "allow",
      permissionUpdates: [
        {
          behavior: "allow",
          rules: [{ ruleContent: "pnpm run lint --fix", toolName: "Bash" }],
          type: "addRules",
        },
      ],
    });
  });

  it("passes the tool-reported confirmation preview through to the legacy request", () => {
    const display = {
      kind: "create_workflow" as const,
      ok: true,
      errorCount: 0,
      diagnostics: [],
      causalityGraph: {
        steps: [
          {
            id: "ask#1",
            kind: "ask" as const,
            label: "a",
            line: 2,
            column: 21,
            lane: "actor#1",
          },
        ],
        lanes: [{ id: "actor#1", name: "a", line: 2, column: 11 }],
        edges: [],
        sink: ["ask#1"],
      },
    };
    const request = pendingPermissionToLegacyRequest("sess-1", {
      interactionId: "perm-workflow",
      kind: "permission",
      anchorRowId: 7,
      createdAt: 100,
      payload: {
        kind: "permission",
        toolCallId: "tc-workflow",
        toolName: "CreateWorkflow",
        summary: "createWorkflow.runConfirmation: user must confirm running the analyzed script",
        detail: { name: "Research pipeline", script: "const x = 1;" },
        display,
        options: [
          { optionId: "allowOnce", label: "Allow", kind: "allowOnce" },
          { optionId: "deny", label: "Deny", kind: "deny" },
        ],
      },
    });

    expect(request.display).toEqual(display);
    // detail/raw 的形状被所有工具的预览解析共用，preview 不得从这里走私。
    expect(request.raw).toEqual({ name: "Research pipeline", script: "const x = 1;" });
  });

  it("omits display when the ask carries no preview", () => {
    const request = pendingPermissionToLegacyRequest("sess-1", {
      interactionId: "perm-no-display",
      kind: "permission",
      anchorRowId: null,
      createdAt: 100,
      payload: {
        kind: "permission",
        toolCallId: "tc-1",
        toolName: "Bash",
        summary: "Run ls",
        detail: { command: "ls" },
        options: [{ optionId: "allow", label: "Allow", kind: "allowOnce" }],
      },
    });

    expect(request.display).toBeUndefined();
    expect("display" in request).toBe(false);
  });

  it("maps v4 userInput interaction to view model", () => {
    const model = pendingUserInputToViewModel({
      interactionId: "input-1",
      kind: "userInput",
      anchorRowId: null,
      createdAt: 200,
      payload: {
        kind: "userInput",
        prompt: "Continue?",
        freeText: true,
        options: [{ optionId: "yes", label: "Yes" }],
      },
    });

    expect(model.interactionId).toBe("input-1");
    expect(model.prompt).toBe("Continue?");
    expect(model.freeText).toBe(true);
    expect(model.options).toHaveLength(1);
  });

  it("maps structured v4 userInput interaction to ElicitationDialog request", () => {
    const request = pendingUserInputToElicitationRequest("sess-1", {
      interactionId: "ask-1",
      kind: "userInput",
      anchorRowId: 5,
      createdAt: 300,
      payload: {
        kind: "userInput",
        prompt: "请选择",
        freeText: true,
        toolName: "AskUserQuestion",
        toolCallId: "tool-ask",
        traceId: "trace-ask",
        schema: { toolName: "AskUserQuestion" },
        questions: [
          {
            question: "你想怎么做？",
            header: "方案",
            options: [
              { value: "fast", label: "快速", description: "先做最小修复" },
              { value: "safe", label: "稳妥", description: "补齐测试和文档" },
            ],
          },
        ],
      },
    });

    expect(request).toMatchObject({
      type: "elicitation_request",
      taskId: "sess-1",
      traceId: "trace-ask",
      requestId: "ask-1",
      message: "你想怎么做？",
      header: "方案",
      schema: { toolName: "AskUserQuestion" },
      questions: [
        {
          question: "你想怎么做？",
          header: "方案",
          options: [
            { value: "fast", label: "快速", description: "先做最小修复" },
            { value: "safe", label: "稳妥", description: "补齐测试和文档" },
          ],
        },
      ],
    });
  });
});
