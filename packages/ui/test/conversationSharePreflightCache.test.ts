import { describe, expect, it } from "vitest";
import type {
  ConversationSharePreflightResult,
  ConversationShareTurnPreflightResult,
} from "@zcode/services";
import {
  aggregateConversationShareBlockingIssues,
  buildConversationSharePreflightCacheEntries,
  conversationSharePreflightCacheKey,
  conversationShareTurnFingerprint,
  dedupeConversationShareIssues,
  getMissingConversationSharePreflightTurnIds,
} from "@/v4/conversationSharePreflightCache.js";

function cached(productTurnId: string): ConversationShareTurnPreflightResult {
  return {
    productTurnId,
    blockingIssues: [],
    skippableWarnings: [],
    deferredIssues: [],
  };
}

describe("conversation share per-turn preflight cache", () => {
  it("turn fingerprint 随附件元数据变化而变化", () => {
    const rows = [
      {
        rowId: 1,
        turnId: "turn-1",
        productTurnId: "turn-1",
        createdAt: 1,
        createdAtSeq: 1,
        kind: "userInput" as const,
        text: "",
        origin: "realUser" as const,
        attachments: [
          {
            ref: "/tmp/a.txt",
            fileName: "a.txt",
            mime: "text/plain",
            bytes: 1,
          },
        ],
      },
    ];
    const first = conversationShareTurnFingerprint(rows, "turn-1");
    const second = conversationShareTurnFingerprint(
      [
        {
          ...rows[0]!,
          attachments: [{ ...rows[0]!.attachments[0]!, bytes: 2 }],
        },
      ],
      "turn-1",
    );
    expect(first).not.toBe(second);
    expect(conversationShareTurnFingerprint(rows, "turn-1")).toBe(first);
  });

  it("turn fingerprint 绑定分享 scope、会话水位和能力版本", () => {
    const rows = [
      {
        rowId: 1,
        turnId: "turn-1",
        productTurnId: "turn-1",
        createdAt: 1,
        createdAtSeq: 1,
        kind: "assistantText" as const,
        text: "生成 report.pdf",
        state: "complete" as const,
      },
    ];
    const context = {
      workspaceKey: "/workspace",
      remoteSessionId: "remote-1",
      sessionId: "session-1",
      revision: 7,
      logEpoch: "epoch-1",
      capabilitiesFingerprint: "cap-1",
    };
    const first = conversationShareTurnFingerprint(rows, "turn-1", "/workspace", context);
    expect(
      conversationShareTurnFingerprint(rows, "turn-1", "/workspace", {
        ...context,
        capabilitiesFingerprint: "cap-2",
      }),
    ).not.toBe(first);
    expect(
      conversationShareTurnFingerprint(rows, "turn-1", "/workspace", {
        ...context,
        revision: 8,
      }),
    ).not.toBe(first);
    expect(
      conversationShareTurnFingerprint(rows, "turn-1", "/workspace", {
        ...context,
        remoteSessionId: "remote-2",
      }),
    ).not.toBe(first);
  });

  it("只返回首次加入且尚未检查的 turn，取消后重新选择不重复检查", () => {
    const scopeKey = "workspace-a\u0000remote-a\u0000session-a";
    const cache = new Map<string, ConversationShareTurnPreflightResult>([
      [
        conversationSharePreflightCacheKey(scopeKey, "turn-1"),
        { ...cached("turn-1"), turnFingerprint: "fp-1" },
      ],
      [
        conversationSharePreflightCacheKey(scopeKey, "turn-2"),
        { ...cached("turn-2"), turnFingerprint: "fp-2" },
      ],
    ]);
    const fingerprints = new Map([
      ["turn-1", "fp-1"],
      ["turn-2", "fp-2"],
    ]);

    expect(
      getMissingConversationSharePreflightTurnIds(scopeKey, ["turn-1"], cache, fingerprints),
    ).toEqual([]);
    expect(
      getMissingConversationSharePreflightTurnIds(
        scopeKey,
        ["turn-1", "turn-2"],
        cache,
        fingerprints,
      ),
    ).toEqual([]);
    expect(
      getMissingConversationSharePreflightTurnIds(
        scopeKey,
        ["turn-1", "turn-2", "turn-3"],
        cache,
        fingerprints,
      ),
    ).toEqual(["turn-3"]);
    expect(
      getMissingConversationSharePreflightTurnIds(
        scopeKey,
        ["turn-1"],
        cache,
        new Map([["turn-1", "fp-changed"]]),
      ),
    ).toEqual(["turn-1"]);
  });

  it("不同 workspace/session scope 不复用同名 product turn", () => {
    const cache = new Map<string, ConversationShareTurnPreflightResult>([
      [conversationSharePreflightCacheKey("scope-a", "turn-1"), cached("turn-1")],
    ]);

    expect(getMissingConversationSharePreflightTurnIds("scope-b", ["turn-1"], cache)).toEqual([
      "turn-1",
    ]);
  });

  it("聚合时只去重没有轮次/文件定位信息的重复全局问题", () => {
    const globalIssue = {
      code: "unknown" as const,
      scope: "transport" as const,
    };
    expect(dedupeConversationShareIssues([globalIssue, { ...globalIssue }])).toEqual([globalIssue]);

    expect(
      dedupeConversationShareIssues([
        {
          code: "running_turn" as const,
          scope: "turn" as const,
          turnOrdinal: 1,
        },
        {
          code: "running_turn" as const,
          scope: "turn" as const,
          turnOrdinal: 2,
        },
      ]),
    ).toHaveLength(2);
    expect(
      dedupeConversationShareIssues([
        { code: "running_turn" as const, scope: "turn" as const },
        { code: "running_turn" as const, scope: "turn" as const },
      ]),
    ).toHaveLength(2);
  });

  it("host 未返回 turnResults 时回落到整体 issues，而不是抛异常", () => {
    const blockingIssues = [{ code: "running_turn" as const, scope: "turn" as const }];
    // 老版本 host（未随 services 重建重启）返回的结果里没有 turnResults 字段。
    const legacyResult = {
      revision: 3,
      logEpoch: "epoch-1",
      capabilitiesFingerprint: "fingerprint",
      blockingIssues,
      skippableWarnings: [],
      deferredIssues: [],
      supportedArtifactTypes: [],
    } as unknown as ConversationSharePreflightResult;

    expect(
      buildConversationSharePreflightCacheEntries(
        legacyResult,
        ["turn-1", "turn-2"],
        new Map([["turn-1", "fp-1"]]),
      ),
    ).toEqual([
      {
        productTurnId: "turn-1",
        turnFingerprint: "fp-1",
        blockingIssues,
        skippableWarnings: [],
        deferredIssues: [],
      },
      {
        productTurnId: "turn-2",
        turnFingerprint: undefined,
        blockingIssues,
        skippableWarnings: [],
        deferredIssues: [],
      },
    ]);
  });

  it("有 turnResults 时按 turn 拆分，并补上当前 fingerprint", () => {
    const result: ConversationSharePreflightResult = {
      revision: 3,
      logEpoch: "epoch-1",
      capabilitiesFingerprint: "fingerprint",
      blockingIssues: [{ code: "running_turn", scope: "turn", turnOrdinal: 2 }],
      skippableWarnings: [],
      deferredIssues: [],
      supportedArtifactTypes: [],
      turnResults: [
        {
          productTurnId: "turn-2",
          blockingIssues: [{ code: "running_turn", scope: "turn", turnOrdinal: 2 }],
          skippableWarnings: [],
          deferredIssues: [],
        },
      ],
    };

    const entries = buildConversationSharePreflightCacheEntries(
      result,
      ["turn-1", "turn-2"],
      new Map([
        ["turn-1", "fp-1"],
        ["turn-2", "fp-2"],
      ]),
    );

    // turn-1 没有明细：回落整体 issues；turn-2 用自己的明细。
    expect(entries[0]).toEqual({
      productTurnId: "turn-1",
      turnFingerprint: "fp-1",
      blockingIssues: result.blockingIssues,
      skippableWarnings: [],
      deferredIssues: [],
    });
    expect(entries[1]).toEqual({
      productTurnId: "turn-2",
      turnFingerprint: "fp-2",
      blockingIssues: [{ code: "running_turn", scope: "turn", turnOrdinal: 2 }],
      skippableWarnings: [],
      deferredIssues: [],
    });
  });
});

it("累计行数超限随选择重算，取消轮次后不残留旧错误", () => {
  const first = {
    ...cached("a"),
    rowBudget: { count: 3, limit: 5 },
    blockingIssues: [
      { code: "rows_limit" as const, scope: "conversation" as const, actual: 6, limit: 5 },
    ],
  };
  const second = { ...cached("b"), rowBudget: { count: 3, limit: 5 } };
  expect(aggregateConversationShareBlockingIssues([first, second])).toEqual([
    { code: "rows_limit", scope: "conversation", actual: 6, limit: 5 },
  ]);
  expect(aggregateConversationShareBlockingIssues([first])).toEqual([]);
});

it("内嵌图片变化会使轮次缓存失效", () => {
  const row = {
    kind: "toolCall" as const,
    rowId: 1,
    turnId: "t",
    productTurnId: "p",
    createdAt: 1,
    createdAtSeq: 1,
    toolCallId: "tool",
    toolName: "NodeRepl",
    status: "success" as const,
    display: {
      kind: "node_repl_images" as const,
      images: [{ base64: "aGVsbG8=", mimeType: "image/png" }],
    },
  };
  const before = conversationShareTurnFingerprint([row], "p");
  expect(
    conversationShareTurnFingerprint(
      [
        {
          ...row,
          display: { ...row.display, images: [{ base64: "d29ybGQ=", mimeType: "image/png" }] },
        },
      ],
      "p",
    ),
  ).not.toBe(before);
});
