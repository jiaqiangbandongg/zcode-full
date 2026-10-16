import { describe, expect, it } from "vitest";

import {
  buildConversationShareConfirmRequest,
  canonicalizeConversationShareJson,
  sha256ConversationShareJson,
  verifyConversationShareIntegrity,
} from "../src/conversation-share/conversationShareIntegrity.js";

describe("conversation share RFC 8785 integrity", () => {
  it("canonicalizes the RFC 8785 primitive sample", () => {
    const value = {
      numbers: [333_333_333.3333333, 1e30, 4.5, 2e-3, 1e-27],
      string: "€$\u000f\nA'B\"\\\"/",
      literals: [null, true, false],
    };

    expect(canonicalizeConversationShareJson(value)).toBe(
      "{\"literals\":[null,true,false],\"numbers\":[333333333.3333333,1e+30,4.5,0.002,1e-27],\"string\":\"€$\\u000f\\nA'B\\\"\\\\\\\"/\"}",
    );
  });

  it("sorts object keys recursively without reordering arrays", () => {
    expect(
      canonicalizeConversationShareJson({ z: { b: 1, a: 2 }, a: [3, { d: 4, c: 5 }] }),
    ).toBe('{"a":[3,{"c":5,"d":4}],"z":{"a":2,"b":1}}');
  });

  it("uses ECMAScript JSON number serialization", () => {
    expect(canonicalizeConversationShareJson([-0, 1e30, 1e-7, 0.000001])).toBe(
      "[0,1e+30,1e-7,0.000001]",
    );
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects non-finite number %s",
    (value) => {
      expect(() => canonicalizeConversationShareJson(value)).toThrow("finite");
    },
  );

  it("rejects lone Unicode surrogates in keys and values", () => {
    expect(() => canonicalizeConversationShareJson("\ud800")).toThrow("Unicode");
    expect(() => canonicalizeConversationShareJson({ "\udfff": true })).toThrow("Unicode");
  });

  it("produces stable lower-case SHA-256", () => {
    expect(sha256ConversationShareJson([])).toBe(
      "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
    );
    expect(sha256ConversationShareJson({ b: 1, a: 2 })).toBe(
      "d3626ac30a87e6f7a6428233b3c68299976865fa5508e4267c5415c76af7a772",
    );
  });

  it("builds the revision 23 slim confirm request and its two integrity hashes", () => {
    const rows = [
      {
        rowId: 1,
        turnId: "turn-1",
        productTurnId: "product-turn-1",
        createdAt: 1,
        createdAtSeq: 1,
        kind: "turnHeader" as const,
        origin: "userInput" as const,
        state: "completedSuccess" as const,
        startedAt: 1,
        endedAt: 2,
      },
    ];
    const disclosureConfirmation = {
      version: 1 as const,
      accepted_at: 3,
      acknowledged_no_secret_detection: true as const,
    };
    const request = buildConversationShareConfirmRequest({
      selected_product_turn_ids: ["product-turn-1"],
      projection: { rows },
      artifacts: [],
      disclosure_confirmation: disclosureConfirmation,
    });

    expect(request).toEqual({
      selected_product_turn_ids: ["product-turn-1"],
      projection: { rows },
      integrity: {
        projection_sha256: "7a748f1dac380029522841af7a40f7d33004368435c7e08a09c4a09c7592b7ba",
        artifact_set_sha256: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
      },
      disclosure_confirmation: disclosureConfirmation,
    });
    expect(sha256ConversationShareJson(request)).toBe(
      "fab3b7aa64630a19ea2c92bbc47363184300e9cbc03e90cb453a01077c777fc2",
    );
  });
});

/**
 * 跨版本完整性：摘要必须对服务端原样发来的值算，否则「给 row 加一个 optional 字段」这种
 * 纯 additive 演进会被老客户端误报成「分享文件校验失败」。
 */
describe("verifyConversationShareIntegrity", () => {
  const descriptor = {
    artifact_id: "artifact-1",
    logical_artifact_key: "report",
    producer_product_turn_id: "product-turn-1",
    artifact_version: 1,
    state: "current",
    ref: "zcode-artifact://share/artifact-1",
    artifact_type: "md",
    display_name: "report.md",
    extension: "md",
    mime_type: "text/markdown",
    size_bytes: 3,
    sha256: "b".repeat(64),
  };
  const rows = [
    {
      rowId: 1,
      turnId: "turn-1",
      createdAt: 1,
      createdAtSeq: 1,
      kind: "assistantText",
      text: "hi",
      state: "complete",
    },
  ];

  it("接受未知字段：更新版发布端加的 row 字段与 descriptor 字段都算进摘要", () => {
    const futureRows = [{ ...rows[0], futureRowField: "x" }];
    const futureDescriptor = { ...descriptor, futureDescriptorField: "y" };
    expect(
      verifyConversationShareIntegrity({
        rawRows: futureRows,
        // 服务端读取时附加的 signed URL 字段不参与摘要。
        rawArtifacts: [
          { ...futureDescriptor, download_url: "https://x/y", download_url_expires_at: 9 },
        ],
        integrity: {
          projection_sha256: sha256ConversationShareJson(futureRows),
          artifact_set_sha256: sha256ConversationShareJson([futureDescriptor]),
        },
      }),
    ).toBe(true);
  });

  it("按 artifact_id 排序后再算 manifest 摘要，响应顺序不影响判定", () => {
    const second = { ...descriptor, artifact_id: "artifact-0" };
    expect(
      verifyConversationShareIntegrity({
        rawRows: rows,
        rawArtifacts: [descriptor, second],
        integrity: {
          projection_sha256: sha256ConversationShareJson(rows),
          artifact_set_sha256: sha256ConversationShareJson([second, descriptor]),
        },
      }),
    ).toBe(true);
  });

  it("内容真被改过时仍然拒绝", () => {
    expect(
      verifyConversationShareIntegrity({
        rawRows: [{ ...rows[0], text: "tampered" }],
        rawArtifacts: [descriptor],
        integrity: {
          projection_sha256: sha256ConversationShareJson(rows),
          artifact_set_sha256: sha256ConversationShareJson([descriptor]),
        },
      }),
    ).toBe(false);
  });
});
