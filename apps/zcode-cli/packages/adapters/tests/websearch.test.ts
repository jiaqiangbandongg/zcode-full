// ============================================================
// Internal Provider-Native WebSearch Model Tool Tests
// ============================================================

import {
  WEBSEARCH_PROVIDER_NATIVE_SPEC,
  WEBSEARCH_TOOL_CONTRACT,
  type ModelToolContract,
} from "@zcode/contracts";
import { describe, expect, it } from "vitest";
import { toAiSdkTools } from "../src/model/index.js";

function createInternalProviderNativeWebSearchContract(
  args?: Record<string, unknown>,
): ModelToolContract {
  return {
    name: "web_search",
    capability: "web_search",
    description: "Provider-native web search used internally by WebSearch",
    executionMode: "providerNative",
    inputSchema: WEBSEARCH_TOOL_CONTRACT.inputSchema,
    outputSchema: WEBSEARCH_TOOL_CONTRACT.outputSchema,
    providerNative: {
      ...WEBSEARCH_PROVIDER_NATIVE_SPEC,
      args,
    },
  };
}

describe("internal provider-native WebSearch model tools", () => {
  it("keeps the public WebSearch model-facing tool as WebSearch", () => {
    const tools = toAiSdkTools(
      [
        {
          name: "WebSearch",
          capability: "web_search",
          description: "Search the web",
          executionMode: "client",
          inputSchema: WEBSEARCH_TOOL_CONTRACT.inputSchema,
          outputSchema: WEBSEARCH_TOOL_CONTRACT.outputSchema,
        },
      ],
      { providerKind: "anthropic" },
    );

    expect(Object.keys(tools ?? {})).toEqual(["WebSearch"]);
    expect(tools?.web_search).toBeUndefined();
    expect(tools?.WebSearch).not.toMatchObject({
      id: "anthropic.web_search_20260209",
      type: "provider",
    });
  });

  it("maps internal web_search to Anthropic provider tools", () => {
    const tools = toAiSdkTools(
      [
        createInternalProviderNativeWebSearchContract({
          allowedDomains: ["example.com"],
          blockedDomains: ["blocked.example"],
          maxUses: 3,
        }),
      ],
      {
        providerKind: "anthropic",
        supportsNativeWebSearch: true,
      },
    );

    expect(tools?.web_search).toMatchObject({
      args: {
        allowedDomains: ["example.com"],
        blockedDomains: ["blocked.example"],
        maxUses: 3,
      },
      id: "anthropic.web_search_20260209",
      type: "provider",
    });
  });

  it("maps Anthropic native WebSearch from the resolved Model Config fact", () => {
    const tools = toAiSdkTools([createInternalProviderNativeWebSearchContract()], {
      providerKind: "anthropic",
      supportsNativeWebSearch: true,
    });

    expect(tools?.web_search).toMatchObject({
      id: "anthropic.web_search_20260209",
      type: "provider",
    });
  });

  it.each(["openai", "openai-compatible"] as const)(
    "fails closed for a configured native WebSearch capability unsupported by API kind %s",
    (providerKind) => {
      expect(() =>
        toAiSdkTools([createInternalProviderNativeWebSearchContract()], {
          providerKind,
          supportsNativeWebSearch: true,
        }),
      ).toThrowError(/does not encode provider-native WebSearch/u);
    },
  );

  it("fails closed when the effective model capability is disabled", () => {
    expect(() =>
      toAiSdkTools([createInternalProviderNativeWebSearchContract()], {
        providerKind: "anthropic",
        supportsNativeWebSearch: false,
      }),
    ).toThrowError(/does not support provider-native WebSearch/u);
  });
});
