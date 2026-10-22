import { expect, it } from "vitest";
import { createSessionId, type Model, type ModelRequest } from "@zcode/contracts";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestModelFactory } from "./test-runtime-model.js";
import { createTestSessionEventStore } from "./test-event-store.js";

it.each([
  { force: false, childCodingPlan: false, searchAllowed: true, local: true, explore: true },
  { force: false, childCodingPlan: false, searchAllowed: true, local: true },
  { force: false, childCodingPlan: false, searchAllowed: false, local: true },
  { force: false, childCodingPlan: false, searchAllowed: true },
  { force: false, childCodingPlan: true, searchAllowed: true },
  { force: true, childCodingPlan: false, searchAllowed: true },
  { force: true, childCodingPlan: false, searchAllowed: false },
])(
  "uses the child Model, startup override, independent discovery and allowed scope: %j",
  async ({ force, childCodingPlan, searchAllowed, local = false, explore = false }) => {
    const childRequests: ModelRequest[] = [];
    const parentRequests: ModelRequest[] = [];
    const childEnabled = (local || force || childCodingPlan) && searchAllowed;
    const factory = createTestModelFactory({
      async generateText(request, observation) {
        const child = observation.invocationContext?.metadata?.querySource === "subagent";
        const requests = child ? childRequests : parentRequests;
        requests.push(request);
        if (!child && requests.length === 1)
          return {
            text: "",
            usage: {},
            finishReason: "tool-calls",
            toolCalls: [
              {
                id: "spawn",
                name: "Agent",
                input: {
                  description: "Search scoped tools",
                  prompt: "Discover WebFetch",
                  subagent_type: explore ? "Explore" : "researcher",
                },
              },
            ],
          };
        if (child && childEnabled && requests.length === 1)
          return {
            text: "",
            usage: {},
            finishReason: "tool-calls",
            toolCalls: [
              {
                id: "child-search",
                name: "ToolSearch",
                input: { query: explore ? "select:WebFetch" : "select:WebFetch,TodoWrite" },
              },
            ],
          };
        return { text: "done", usage: {}, finishReason: "stop" };
      },
    });
    const withCapability = (model: Model): Model => ({
      ...model,
      requestCapabilities: {
        toolSearch: {
          protocolSupported: true,
          defaultEnabled: model.modelId === "child" ? childCodingPlan : true,
        },
      },
      bind: (options) => withCapability(model.bind(options)),
    });
    const runtime = createTestAgentRuntime(
      createSessionId("toolsearch-subagent"),
      {
        mode: "yolo",
        modelStreaming: "off",
        titleGeneration: { enabled: false },
        toolSearch: { mode: local ? "local" : force ? "native" : "auto" },
        modelSelection: { providerId: "test", modelId: "parent" },
        subagents: explore
          ? undefined
          : {
              profiles: [
                {
                  name: "researcher",
                  description: "Research",
                  source: "user",
                  systemPrompt: "Search tools",
                  modelSelection: { providerId: "test", modelId: "child" },
                  tools: searchAllowed
                    ? ["ToolSearch", ...(local ? ["DeferredToolCall"] : []), "WebFetch"]
                    : ["WebFetch"],
                },
              ],
            },
      },
      {
        eventStore: createTestSessionEventStore(),
        modelFactory: (input) => withCapability(factory(input)),
      },
    );
    try {
      await runtime.executeTurn("Run the researcher.");
      expect(childRequests.length).toBe(childEnabled ? 2 : 1);
      expect(childRequests[0]?.toolSearchEnabled).toBe(childEnabled && !local);
      expect(childRequests[0]?.tools?.some((tool) => tool.name === "ToolSearch")).toBe(
        childEnabled,
      );
      if (childEnabled) {
        expect(childRequests[0]?.tools?.some((tool) => tool.name === "WebFetch")).toBe(false);
        if (local) {
          expect(childRequests[1]?.tools).toEqual(childRequests[0]?.tools);
          expect(JSON.stringify(childRequests[1]?.messages)).toContain("<functions>");
          expect(JSON.stringify(childRequests[1]?.messages)).not.toContain(
            '"toolName":"TodoWrite"',
          );
        } else {
          expect(
            childRequests[1]?.tools?.find((tool) => tool.name === "WebFetch")?.deferLoading,
          ).toBe(true);
          expect(
            childRequests[1]?.messages.find((message) => message.role === "tool")?.content,
          ).toEqual([{ type: "tool_reference", toolName: "WebFetch" }]);
        }
      } else expect(childRequests[0]?.tools?.some((tool) => tool.name === "WebFetch")).toBe(true);
      expect(parentRequests.at(-1)?.tools?.some((tool) => tool.name === "WebFetch")).toBe(false);
    } finally {
      await runtime.closeBrowserSession();
    }
  },
);
