import { describe, expect, it } from "vitest";
import {
  HookSourceKind,
  WORKSPACE_HOOK_SCHEMA_FIELDS,
  WORKSPACE_HOOK_STATE_ADMISSION_MAP,
  canonicalWorkspaceHookEntrySchema,
  createWorkspaceHookBundleSnapshot,
  workspaceHookEffectiveStateSchema,
  workspaceHookReviewFlowStateSchema,
} from "../src/hooks/index.js";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

function canonicalEntry() {
  return {
    reviewItemId: "review-item-1",
    event: "SessionStart",
    matcherIndex: 0,
    hookIndex: 0,
    sourceFileIndex: 0,
    sourceRelativePath: ".zcode/config.json",
    matcher: "startup",
    type: "command",
    command: "./scripts/start.sh",
    async: true,
    shell: true,
    resolvedTimeoutMs: 30_000,
    resolvedMaxOutputBytes: 32_768,
    sourceRootEnabled: true,
    declarationEnabled: true,
    runtimeHooksEnabled: true,
    configuredEnabled: true,
    editable: true,
    declarationDigestAlgorithm: "sha256",
    hookDeclarationDigest: DIGEST_A,
  } as const;
}

describe("workspace hook trust contracts", () => {
  it("固化 project provenance 与真实 Hook schema exhaustive lock", () => {
    expect(HookSourceKind.Project).toBe("project");
    expect(WORKSPACE_HOOK_SCHEMA_FIELDS).toEqual({
      root: ["enabled", "timeoutMs", "maxOutputBytes", "events"],
      matcher: ["matcher", "hooks"],
      events: [
        "SessionStart",
        "UserPromptSubmit",
        "PreToolUse",
        "PermissionRequest",
        "PostToolUse",
        "PostToolUseFailure",
        "Stop",
      ],
      process: ["type", "command", "enabled", "args", "timeoutMs", "statusMessage"],
      command: [
        "type",
        "command",
        "enabled",
        "async",
        "shell",
        "timeout",
        "timeoutMs",
        "statusMessage",
      ],
    });
  });

  it("固化 state/admission/effective/reason 唯一映射", () => {
    expect(WORKSPACE_HOOK_STATE_ADMISSION_MAP).toEqual({
      not_applicable: {
        admissionClass: "not_applicable",
        effectiveRunnable: false,
        reasonCode: "workspace_hooks_not_applicable",
      },
      pending_trust: {
        admissionClass: "pending",
        effectiveRunnable: false,
        reasonCode: "workspace_hooks_pending_trust",
      },
      trusted_persistent: {
        admissionClass: "admitted",
        effectiveRunnable: "configured",
        reasonCode: "workspace_hooks_trusted_persistent",
      },
      blocked_untrusted: {
        admissionClass: "blocked",
        effectiveRunnable: false,
        reasonCode: "workspace_hooks_blocked_untrusted",
      },
      blocked_policy: {
        admissionClass: "blocked",
        effectiveRunnable: false,
        reasonCode: "workspace_hooks_blocked_by_policy",
      },
      revoked: {
        admissionClass: "pending",
        effectiveRunnable: false,
        reasonCode: "workspace_hooks_revoked",
      },
      stale_digest: {
        admissionClass: "pending",
        effectiveRunnable: false,
        reasonCode: "workspace_hook_declaration_changed",
      },
    });

    expect(
      workspaceHookEffectiveStateSchema.safeParse({
        reviewItemId: "review-item-1",
        sourceRootEnabled: true,
        declarationEnabled: true,
        runtimeHooksEnabled: true,
        configuredEnabled: true,
        editable: true,
        trustState: "revoked",
        admissionClass: "blocked",
        effectiveRunnable: false,
        sourcePaths: [".zcode/config.json"],
        reasonCode: "workspace_hooks_blocked_untrusted",
      }).success,
    ).toBe(false);
  });

  it("固化 immutable snapshot 与两层 digest", () => {
    expect(canonicalWorkspaceHookEntrySchema.parse(canonicalEntry())).toMatchObject({
      hookDeclarationDigest: DIGEST_A,
      configuredEnabled: true,
    });

    const snapshot = createWorkspaceHookBundleSnapshot({
      schemaVersion: 1,
      workspaceIdentity: "local:/workspace",
      discoveredAt: "2026-08-06T00:00:00.000Z",
      sourceFiles: [
        {
          canonicalPath: "/workspace/.zcode/config.json",
          baseDir: "/workspace",
          discoveryOrder: 0,
          configFileKind: ".zcode/config.json",
          explicitProjectConfig: false,
          editable: true,
          hooksRoot: { enabled: true, timeoutMs: 30_000, maxOutputBytes: 32_768 },
        },
      ],
      hooks: [canonicalEntry()],
      digestAlgorithm: "sha256",
      bundleDigest: DIGEST_B,
    });

    expect(snapshot.bundleDigest).toBe(DIGEST_B);
    expect(snapshot.hooks[0]?.hookDeclarationDigest).toBe(DIGEST_A);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.hooks)).toBe(true);
  });

  it("固化 generation supersede 状态约束", () => {
    expect(
      workspaceHookReviewFlowStateSchema.safeParse({
        reviewFlowId: "flow-1",
        generation: 1,
        interactionId: "interaction-1",
        sessionId: "session-1",
        workspaceIdentity: "local:/workspace",
        bundleDigest: DIGEST_B,
        state: "superseded",
        createdAt: 1,
        deadlineAt: 2,
      }).success,
    ).toBe(false);

    expect(
      workspaceHookReviewFlowStateSchema.safeParse({
        reviewFlowId: "flow-1",
        generation: 1,
        interactionId: "interaction-1",
        sessionId: "session-1",
        workspaceIdentity: "local:/workspace",
        bundleDigest: DIGEST_B,
        state: "superseded",
        supersededByInteractionId: "interaction-2",
        createdAt: 1,
        deadlineAt: 2,
      }).success,
    ).toBe(true);
  });
});

describe("workspace hook trust phase 2 contracts", () => {
  it("固化 Trust store record、唯一 key 与私有诊断 metadata", async () => {
    const {
      WORKSPACE_HOOK_TRUST_STORE_SCHEMA_VERSION,
      workspaceHookTrustRecordSchema,
      workspaceHookTrustStoreFileSchema,
    } = await import("../src/hooks/index.js");
    const record = workspaceHookTrustRecordSchema.parse({
      workspaceIdentity: "local:/workspace",
      hookDeclarationDigest: DIGEST_A,
      digestAlgorithm: "sha256",
      decision: "trusted",
      grantedAt: "2026-08-06T00:00:00.000Z",
      bundleDigestAtGrant: DIGEST_B,
      eventAtGrant: "SessionStart",
      displayCommandAtGrant: "./scripts/start.sh",
      sourcePathAtGrant: ".zcode/config.json",
      sourceDiscoveryOrderAtGrant: 0,
      matcherAtGrant: "startup",
      matcherIndexAtGrant: 0,
      hookIndexAtGrant: 0,
    });
    expect(WORKSPACE_HOOK_TRUST_STORE_SCHEMA_VERSION).toBe(1);
    expect(record.matcherAtGrant).toBe("startup");
    expect(
      workspaceHookTrustStoreFileSchema.safeParse({
        schemaVersion: 1,
        records: [record, record],
      }).success,
    ).toBe(false);
  });

  it("固化 managed policy，临时授权不再属于 Workspace Hook 契约", async () => {
    const { workspaceHookPolicySchema } = await import("../src/hooks/index.js");

    expect(
      workspaceHookPolicySchema.parse({
        mode: "allow_trusted_only",
        reason: "organization pre-approval required",
        policyRevision: "managed:7",
      }),
    ).toMatchObject({ mode: "allow_trusted_only", policyRevision: "managed:7" });
    expect(
      workspaceHookPolicySchema.safeParse({ mode: "deny", policyRevision: "managed:8" }).success,
    ).toBe(false);

    expect(
      workspaceHookPolicySchema.parse({
        mode: "user_decides",
        policyRevision: "user:1",
      }),
    ).toMatchObject({ mode: "user_decides" });
    expect(
      workspaceHookPolicySchema.parse({
        mode: "deny",
        reason: "organization disabled workspace hooks",
        policyRevision: "managed:9",
      }),
    ).toMatchObject({ mode: "deny" });
    expect(
      workspaceHookReviewFlowStateSchema.safeParse({
        reviewFlowId: "flow-1",
        generation: 1,
        interactionId: "interaction-1",
        sessionId: "session-1",
        sessionFamilyId: "legacy-family",
        workspaceIdentity: "local:/workspace",
        bundleDigest: DIGEST_B,
        state: "pending",
        createdAt: 1,
        deadlineAt: 2,
      }).success,
    ).toBe(false);
  });
});
