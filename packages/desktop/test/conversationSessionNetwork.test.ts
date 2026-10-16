import { describe, expect, it } from "vitest";
import { readUpstreamToolResultFromRequest } from "./e2e/helpers/conversation-session-network.js";

describe("conversation session provider capture", () => {
  it("reads the latest matching tool_result error instead of stale success", () => {
    const result = readUpstreamToolResultFromRequest(
      {
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_browser_action",
                content: "stale success",
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_other",
                content: "unrelated failure",
                is_error: true,
              },
              {
                type: "tool_result",
                tool_use_id: "toolu_browser_action",
                content: "E2E_INTENTIONAL_TOOL_FAILURE\n\nStructured content:\n",
                is_error: true,
              },
            ],
          },
        ],
      },
      "toolu_browser_action",
    );

    expect(result).toEqual({
      content: "E2E_INTENTIONAL_TOOL_FAILURE\n\nStructured content:\n",
      isError: true,
      toolCallId: "toolu_browser_action",
    });
  });
});
