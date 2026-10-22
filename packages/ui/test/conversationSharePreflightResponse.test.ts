// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ConversationSharePreflightStatus } from "@/conversation-share-interaction/ConversationSharePreflightStatus.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  ConversationSharePreflightResult,
  ConversationShareTurnPreflightResult,
} from "@zcode/services";
import { logger } from "@/logger.js";
import { createConversationSharePreflightResponseHandlers } from "@/conversation-share-interaction/conversationSharePreflightResponse.js";
import { scheduleConversationSharePreflightRequest } from "@/conversation-share-interaction/conversationSharePreflightRequest.js";
import {
  conversationSharePreflightCacheKey,
  getMissingConversationSharePreflightTurnIds,
} from "@/v4/conversationSharePreflightCache.js";
vi.mock("@/logger.js", () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: { formatMessage: ({ id }: { id: string }) => id },
  }),
}));
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});
function setup() {
  const ids = ["a", "b"];
  const cache = {
    current: new Map<string, ConversationShareTurnPreflightResult>(),
  };
  const meta = {
    current: {
      revision: 1,
      logEpoch: "old",
      capabilitiesFingerprint: "old",
      supportedArtifactTypes: [],
    } as Pick<
      ConversationSharePreflightResult,
      | "revision"
      | "logEpoch"
      | "capabilitiesFingerprint"
      | "supportedArtifactTypes"
    >,
  };
  const fingerprints = new Map(ids.map((id) => [id, `old-${id}`]));
  const onUpdated = vi.fn();
  const isCurrent = vi.fn(() => true);
  const key = (id: string) => conversationSharePreflightCacheKey("scope", id);
  const handlers = createConversationSharePreflightResponseHandlers({
    sessionId: "session",
    workspacePath: "/workspace",
    missingProductTurnIds: ids,
    requestRows: [],
    selectedShareTurnFingerprints: fingerprints,
    sharePreflightCacheRef: cache,
    sharePreflightMetaRef: meta,
    sharePreflightCacheKey: key,
    isCurrent,
    onUpdated,
  });
  const result: ConversationSharePreflightResult = {
    revision: 2,
    logEpoch: "new",
    capabilitiesFingerprint: "new",
    supportedArtifactTypes: [],
    blockingIssues: [],
    skippableWarnings: [],
    deferredIssues: [],
    turnResults: [],
  };
  return {
    ids,
    cache,
    meta,
    fingerprints,
    onUpdated,
    isCurrent,
    handlers,
    key,
    result,
  };
}
it("畸形成功响应结束 checking，保留原元信息，重试成功清除所有阻断", async () => {
  const s = setup();
  const original = s.meta.current;
  scheduleConversationSharePreflightRequest({
    request: async () =>
      ({
        ...s.result,
        turnResults: [null],
      }) as unknown as ConversationSharePreflightResult,
    ...s.handlers,
  });
  await vi.runAllTimersAsync();
  expect(s.meta.current).toBe(original);
  expect(
    getMissingConversationSharePreflightTurnIds(
      "scope",
      s.ids,
      s.cache.current,
      s.fingerprints,
    ),
  ).toEqual([]);
  for (const id of s.ids)
    expect(s.cache.current.get(s.key(id))?.blockingIssues).toEqual([
      { code: "unknown", scope: "transport" },
    ]);
  expect(s.onUpdated).toHaveBeenCalledTimes(1);
  expect(logger.error).toHaveBeenCalledTimes(1);
  const retry = vi.fn(() => {
    s.cache.current.clear();
    scheduleConversationSharePreflightRequest({
      request: async () => s.result,
      ...s.handlers,
    });
  });
  render(
    createElement(ConversationSharePreflightStatus, {
      preflight: {
        ...s.result,
        status: "ready",
        blockingIssues: s.cache.current.get(s.key("a"))!.blockingIssues,
      },
      onRetryPreflight: retry,
    }),
    { wrapper: TooltipProvider },
  );
  fireEvent.click(
    screen.getByTestId("conversation-share-selection-preflight-status"),
  );
  fireEvent.click(screen.getByTestId("conversation-share-preflight-retry"));
  expect(retry).toHaveBeenCalledTimes(1);
  await vi.runAllTimersAsync();
  expect(s.meta.current.capabilitiesFingerprint).toBe("new");
  for (const id of s.ids)
    expect(s.cache.current.get(s.key(id))?.blockingIssues).toEqual([]);
  expect(s.onUpdated).toHaveBeenCalledTimes(2);
});
it("失败处理器抛错仍为所有请求轮次写入可重试终态", async () => {
  const s = setup();
  vi.mocked(logger.warn).mockImplementationOnce(() => {
    throw new Error("handler failed");
  });
  scheduleConversationSharePreflightRequest({
    request: async () => {
      throw new Error("RPC failed");
    },
    ...s.handlers,
  });
  await vi.runAllTimersAsync();
  expect(
    getMissingConversationSharePreflightTurnIds(
      "scope",
      s.ids,
      s.cache.current,
      s.fingerprints,
    ),
  ).toEqual([]);
  expect(s.onUpdated).toHaveBeenCalledTimes(1);
});
it("scope 失效后的处理异常不污染新请求", () => {
  const s = setup();
  s.isCurrent.mockReturnValue(false);
  s.handlers.onError(new Error("stale"));
  s.handlers.onResolved(s.result);
  expect(s.cache.current.size).toBe(0);
  expect(s.meta.current.capabilitiesFingerprint).toBe("old");
  expect(s.onUpdated).not.toHaveBeenCalled();
});
