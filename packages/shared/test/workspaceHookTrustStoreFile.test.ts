import { describe, expect, it } from "vitest";
import {
  WORKSPACE_HOOK_TRUST_STORE_SCHEMA_VERSION,
  parseWorkspaceHookTrustStoreContent,
  workspaceHookTrustStoreFileSchema,
} from "../src/workspace-hook-trust-store-file.js";

const VALID_DIGEST = "a".repeat(64);
const OTHER_DIGEST = "b".repeat(64);

function validRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    workspaceIdentity: "/repo/workspace-a",
    hookDeclarationDigest: VALID_DIGEST,
    digestAlgorithm: "sha256",
    decision: "trusted",
    grantedAt: "2026-08-17T09:00:00.000Z",
    eventAtGrant: "SessionStart",
    displayCommandAtGrant: "node recorder.mjs",
    sourcePathAtGrant: ".zcode/config.json",
    ...overrides,
  };
}

function validFile(records: unknown[]): Record<string, unknown> {
  return { schemaVersion: WORKSPACE_HOOK_TRUST_STORE_SCHEMA_VERSION, records };
}

describe("workspaceHookTrustStoreFileSchema", () => {
  it("接受合法完整记录", () => {
    const result = parseWorkspaceHookTrustStoreContent(
      JSON.stringify(validFile([validRecord(), validRecord({ workspaceIdentity: "/repo/other", hookDeclarationDigest: OTHER_DIGEST })])),
    );
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.file.records).toHaveLength(2);
    expect(result.file.records[0]?.hookDeclarationDigest).toBe(VALID_DIGEST);
  });

  it("拒绝非法 JSON", () => {
    expect(parseWorkspaceHookTrustStoreContent("{ not json").status).toBe("invalid");
  });

  it("拒绝缺少 schemaVersion", () => {
    const { schemaVersion: _schemaVersion, ...rest } = validFile([validRecord()]);
    expect(workspaceHookTrustStoreFileSchema.safeParse(rest).success).toBe(false);
  });

  it("拒绝 records 非数组", () => {
    expect(workspaceHookTrustStoreFileSchema.safeParse({ ...validFile([]), records: "nope" }).success).toBe(false);
  });

  it("拒绝未知顶层字段", () => {
    expect(
      workspaceHookTrustStoreFileSchema.safeParse({ ...validFile([validRecord()]), extra: 1 }).success,
    ).toBe(false);
  });

  it("拒绝缺少必需字段的 record（grantedAt / digestAlgorithm / eventAtGrant / displayCommandAtGrant / sourcePathAtGrant）", () => {
    for (const key of [
      "grantedAt",
      "digestAlgorithm",
      "eventAtGrant",
      "displayCommandAtGrant",
      "sourcePathAtGrant",
      "decision",
      "workspaceIdentity",
      "hookDeclarationDigest",
    ]) {
      const { [key]: _removed, ...record } = validRecord();
      expect(workspaceHookTrustStoreFileSchema.safeParse(validFile([record])).success, key).toBe(false);
    }
  });

  it("拒绝非法 decision / digestAlgorithm", () => {
    expect(
      workspaceHookTrustStoreFileSchema.safeParse(validFile([validRecord({ decision: "maybe" })])).success,
    ).toBe(false);
    expect(
      workspaceHookTrustStoreFileSchema.safeParse(validFile([validRecord({ digestAlgorithm: "md5" })])).success,
    ).toBe(false);
  });

  it("拒绝非法 grantedAt 时间戳", () => {
    expect(
      workspaceHookTrustStoreFileSchema.safeParse(validFile([validRecord({ grantedAt: "yesterday" })])).success,
    ).toBe(false);
  });

  it("拒绝非 64 位 hex digest", () => {
    expect(
      workspaceHookTrustStoreFileSchema.safeParse(validFile([validRecord({ hookDeclarationDigest: "xyz" })])).success,
    ).toBe(false);
  });

  it("拒绝未知 record 字段", () => {
    expect(
      workspaceHookTrustStoreFileSchema.safeParse(validFile([validRecord({ surprise: true })])).success,
    ).toBe(false);
  });

  it("拒绝重复的 workspaceIdentity + digest key", () => {
    expect(
      workspaceHookTrustStoreFileSchema.safeParse(
        validFile([validRecord(), validRecord()]),
      ).success,
    ).toBe(false);
  });

  it("拒绝非法 eventAtGrant 事件名", () => {
    expect(
      workspaceHookTrustStoreFileSchema.safeParse(
        validFile([validRecord({ eventAtGrant: "OnShutdown" })]),
      ).success,
    ).toBe(false);
  });
});
