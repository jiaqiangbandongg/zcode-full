import { describe, expect, it } from "vitest";
import {
  createMessageId,
  createPartId,
  createSessionId,
  type MessageWithParts,
  type ModelId,
  type ModelProviderId,
} from "@zcode/contracts";
import { mapMessageWithParts } from "../src/zcode-protocol/message-mapper.js";

describe("zcode protocol message mapper", () => {
  it("does not expose provider-only tool metadata", () => {
    const sessionID = createSessionId("tool-error-mapper-session");
    const messageID = createMessageId("tool-error-mapper-message");
    const partID = createPartId("tool-error-mapper-part");
    const providerOnlyPartID = createPartId("tool-error-mapper-provider-only-part");
    const rawEmptyPartID = createPartId("tool-error-mapper-raw-empty-part");
    const legitimatePlaceholderPartID = createPartId(
      "tool-error-mapper-legitimate-placeholder-part",
    );
    const modelContent = "<tool_use_error>InputValidationError: missing parameter</tool_use_error>";
    const modelContentLayoutText = "provider-only completed media layout";

    const mapped = mapMessageWithParts({
      info: {
        id: messageID,
        sessionID,
        role: "assistant",
        time: {
          created: 1_700_000_000_000,
          completed: 1_700_000_000_010,
        },
        parentID: createMessageId("tool-error-mapper-parent"),
        modelId: "test-model" as ModelId,
        providerId: "test-provider" as ModelProviderId,
        mode: "build",
        agent: "zcode-agent",
        path: {
          cwd: "/tmp/zcode",
          root: "/tmp/zcode",
        },
        cost: 0,
        tokens: {
          input: 0,
          output: 0,
          reasoning: 0,
          cache: {
            read: 0,
            write: 0,
          },
        },
      },
      parts: [
        {
          id: partID,
          sessionID,
          messageID,
          type: "tool",
          callID: "tool_error_mapper",
          tool: "AskUserQuestion",
          metadata: {
            keepAtPartLevel: "visible",
            providerToolName: "",
          },
          state: {
            status: "error",
            input: {},
            error: "Tool input failed inputSchema validation",
            metadata: {
              keep: "visible",
              modelContent,
            },
            time: {
              start: 1_700_000_000_000,
              end: 1_700_000_000_010,
            },
          },
        },
        {
          id: providerOnlyPartID,
          sessionID,
          messageID,
          type: "tool",
          callID: "tool_error_mapper_provider_only",
          tool: "empty_tool_name",
          metadata: {
            providerToolName: "",
          },
          state: {
            status: "error",
            input: {},
            error: "Model returned an invalid tool call: tool name is empty.",
            time: {
              start: 1_700_000_000_000,
              end: 1_700_000_000_010,
            },
          },
        },
        {
          id: rawEmptyPartID,
          sessionID,
          messageID,
          type: "tool",
          callID: "tool_error_mapper_raw_empty",
          tool: " \t ",
          state: {
            status: "error",
            input: {},
            error: "Model returned an invalid tool call: tool name is empty.",
            time: {
              start: 1_700_000_000_000,
              end: 1_700_000_000_010,
            },
          },
        },
        {
          id: legitimatePlaceholderPartID,
          sessionID,
          messageID,
          type: "tool",
          callID: "tool_error_mapper_legitimate_placeholder",
          tool: "empty_tool_name",
          state: {
            status: "completed",
            input: {},
            output: "ok",
            title: "empty_tool_name",
            metadata: {
              keep: "visible",
              modelContentLayout: [{ type: "text", text: modelContentLayoutText }],
            },
            time: {
              start: 1_700_000_000_000,
              end: 1_700_000_000_010,
            },
          },
        },
      ],
    } satisfies MessageWithParts);

    expect(mapped.parts[0]).toEqual(
      expect.objectContaining({
        metadata: { keepAtPartLevel: "visible" },
        state: expect.objectContaining({
          metadata: { keep: "visible" },
          status: "error",
        }),
        type: "tool",
      }),
    );
    expect(mapped.parts).toHaveLength(2);
    expect(mapped.parts[1]).toMatchObject({
      callId: "tool_error_mapper_legitimate_placeholder",
      state: {
        metadata: { keep: "visible" },
        status: "completed",
      },
      tool: "empty_tool_name",
      type: "tool",
    });
    expect(JSON.stringify(mapped)).not.toContain(modelContent);
    expect(JSON.stringify(mapped)).not.toContain(modelContentLayoutText);
    expect(JSON.stringify(mapped)).not.toContain("modelContentLayout");
    expect(JSON.stringify(mapped)).not.toContain("providerToolName");
    expect(JSON.stringify(mapped)).not.toContain("tool_error_mapper_raw_empty");
  });

  it("preserves timeline parts in session snapshots", () => {
    const sessionID = createSessionId("timeline-mapper-session");
    const messageID = createMessageId("timeline-mapper-message");
    const partID = createPartId("timeline-mapper-part");

    const mapped = mapMessageWithParts({
      info: {
        id: messageID,
        sessionID,
        role: "assistant",
        time: {
          created: 1_700_000_000_000,
          completed: 1_700_000_000_010,
        },
        parentID: createMessageId("timeline-mapper-parent"),
        modelId: "test-model" as ModelId,
        providerId: "test-provider" as ModelProviderId,
        mode: "build",
        agent: "zcode-agent",
        path: {
          cwd: "/tmp/zcode",
          root: "/tmp/zcode",
        },
        cost: 0,
        tokens: {
          input: 0,
          output: 0,
          reasoning: 0,
          cache: {
            read: 0,
            write: 0,
          },
        },
        semantics: {
          origin: "system",
          kind: "timeline_event",
          uiVisibility: "visible",
          providerVisibility: "hidden",
          transcriptVisibility: "visible",
        },
      },
      parts: [
        {
          id: partID,
          sessionID,
          messageID,
          type: "timeline",
          timelineType: "model_change",
          display: "separator",
          status: "completed",
          toModel: {
            providerId: "test-provider" as ModelProviderId,
            modelId: "test-model" as ModelId,
            label: "test-provider/test-model",
          },
          time: {
            start: 1_700_000_000_000,
            end: 1_700_000_000_010,
          },
        },
      ],
    } satisfies MessageWithParts);

    expect(mapped.info).toMatchObject({
      role: "assistant",
      semantics: {
        kind: "timeline_event",
        providerVisibility: "hidden",
      },
    });
    expect(mapped.parts).toEqual([
      expect.objectContaining({
        display: "separator",
        partId: partID,
        timelineType: "model_change",
        toModel: {
          label: "test-provider/test-model",
          modelId: "test-model",
          providerId: "test-provider",
        },
        type: "timeline",
      }),
    ]);
  });
});
