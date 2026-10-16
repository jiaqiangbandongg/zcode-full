import { describe, expect, it } from "vitest";
import type { WorkspaceHookBundleSnapshot, WorkspaceHookTrustRecord } from "@zcode/contracts";
import {
  WORKSPACE_HOOK_STATE_ADMISSION_MAP,
  createWorkspaceHookBundleSnapshot,
} from "@zcode/contracts";
import {
  InMemoryWorkspaceHookPolicyProvider,
  WorkspaceHookTrustCoordinator,
  createWorkspaceHookTrustRecords,
} from "../src/hooks/workspace-hook-trust-domain.js";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const BUNDLE = "c".repeat(64);
const WORKSPACE = "local:/workspace";

function snapshot(
  entries: Array<{
    digest: string;
    command: string;
    configuredEnabled?: boolean;
    hookIndex?: number;
  }> = [{ digest: DIGEST_A, command: "echo one" }],
): WorkspaceHookBundleSnapshot {
  return createWorkspaceHookBundleSnapshot({
    schemaVersion: 1,
    workspaceIdentity: WORKSPACE,
    discoveredAt: "2026-08-06T00:00:00.000Z",
    sourceFiles: [
      {
        canonicalPath: "/workspace/.zcode/config.json",
        baseDir: "/workspace",
        discoveryOrder: 0,
        configFileKind: ".zcode/config.json",
        explicitProjectConfig: false,
        editable: true,
        hooksRoot: { enabled: true },
      },
    ],
    hooks: entries.map((entry, index) => ({
      reviewItemId: `item-${index}`,
      event: "SessionStart",
      matcherIndex: 0,
      hookIndex: entry.hookIndex ?? index,
      sourceFileIndex: 0,
      sourceRelativePath: ".zcode/config.json",
      matcher: "startup",
      type: "command",
      command: entry.command,
      resolvedTimeoutMs: 60_000,
      resolvedMaxOutputBytes: 32_768,
      sourceRootEnabled: true,
      declarationEnabled: true,
      runtimeHooksEnabled: true,
      configuredEnabled: entry.configuredEnabled ?? true,
      editable: true,
      declarationDigestAlgorithm: "sha256",
      hookDeclarationDigest: entry.digest,
    })),
    digestAlgorithm: "sha256",
    bundleDigest: BUNDLE,
  });
}

function record(digest = DIGEST_A): WorkspaceHookTrustRecord {
  return {
    workspaceIdentity: WORKSPACE,
    hookDeclarationDigest: digest,
    digestAlgorithm: "sha256",
    decision: "trusted",
    grantedAt: "2026-08-06T00:00:00.000Z",
    bundleDigestAtGrant: BUNDLE,
    eventAtGrant: "SessionStart",
    displayCommandAtGrant: "echo one",
    sourcePathAtGrant: ".zcode/config.json",
    sourceDiscoveryOrderAtGrant: 0,
    matcherAtGrant: "startup",
    matcherIndexAtGrant: 0,
    hookIndexAtGrant: 0,
  };
}

describe("WorkspaceHookTrustCoordinator", () => {
  it("按 deny > allow_trusted_only > persistent > pending 顺序同步判定", () => {
    const policy = new InMemoryWorkspaceHookPolicyProvider();
    const coordinator = new WorkspaceHookTrustCoordinator({
      coordinatorEpoch: "epoch-1",
      policyProvider: policy,
    });
    coordinator.replacePersistentTrustRecords([record()], { status: "ok" });

    expect(coordinator.evaluateSnapshot({ snapshot: snapshot() }).items[0]).toMatchObject({
      trustState: "trusted_persistent",
      effectiveRunnable: true,
    });

    policy.setWorkspacePolicy(WORKSPACE, {
      mode: "allow_trusted_only",
      policyRevision: "managed:1",
    });
    expect(
      coordinator.evaluateSnapshot({
        snapshot: snapshot([{ digest: DIGEST_B, command: "echo two" }]),
      }).items[0],
    ).toMatchObject({ trustState: "blocked_policy", effectiveRunnable: false });

    policy.setWorkspacePolicy(WORKSPACE, {
      mode: "user_decides",
      policyRevision: "managed:2",
    });
    expect(
      coordinator.evaluateSnapshot({
        snapshot: snapshot([{ digest: DIGEST_B, command: "echo two" }]),
      }).items[0],
    ).toMatchObject({ trustState: "stale_digest", effectiveRunnable: false });

    policy.setWorkspacePolicy(WORKSPACE, {
      mode: "deny",
      reason: "organization disabled workspace hooks",
      policyRevision: "managed:3",
    });
    expect(coordinator.evaluateSnapshot({ snapshot: snapshot() }).items[0]).toMatchObject({
      trustState: "blocked_policy",
      effectiveRunnable: false,
    });
  });

  it("未持久信任不会因同一会话或 coordinator 重建而自动获得准入", () => {
    const coordinator = new WorkspaceHookTrustCoordinator({ coordinatorEpoch: "epoch-1" });
    expect(coordinator.evaluateSnapshot({ snapshot: snapshot() }).items[0]?.trustState).toBe(
      "pending_trust",
    );

    const restarted = new WorkspaceHookTrustCoordinator({ coordinatorEpoch: "epoch-2" });
    expect(restarted.evaluateSnapshot({ snapshot: snapshot() }).items[0]?.trustState).toBe(
      "pending_trust",
    );
  });

  it("policy、持久记录与 revoke 都提升 revision，旧 revision 立即失效且 fast path 同步无 I/O", () => {
    const policy = new InMemoryWorkspaceHookPolicyProvider();
    const coordinator = new WorkspaceHookTrustCoordinator({
      coordinatorEpoch: "epoch-1",
      policyProvider: policy,
    });
    const initial = coordinator.getSecurityRevision(WORKSPACE);

    coordinator.replacePersistentTrustRecords([record()], { status: "ok" });
    const granted = coordinator.getSecurityRevision(WORKSPACE);
    expect(granted.counter).toBeGreaterThan(initial.counter);
    expect(coordinator.validateSecurityRevision(WORKSPACE, initial)).toBe(false);
    expect(coordinator.validateSecurityRevision(WORKSPACE, granted)).toBe(true);

    coordinator.revoke({
      workspaceIdentity: WORKSPACE,
      hookDeclarationDigests: [DIGEST_A],
    });
    const revoked = coordinator.getSecurityRevision(WORKSPACE);
    expect(revoked.counter).toBeGreaterThan(granted.counter);
    expect(
      coordinator.evaluateSnapshot({ snapshot: snapshot() }).items[0],
    ).toMatchObject({
      trustState: "revoked",
      admissionClass: WORKSPACE_HOOK_STATE_ADMISSION_MAP.revoked.admissionClass,
      effectiveRunnable: false,
    });

    policy.setWorkspacePolicy(WORKSPACE, {
      mode: "deny",
      reason: "hot update",
      policyRevision: "managed:4",
    });
    expect(coordinator.getSecurityRevision(WORKSPACE).counter).toBeGreaterThan(revoked.counter);
  });

  it("persistent record 只从 immutable snapshot 和 opaque item id 构造", () => {
    const records = createWorkspaceHookTrustRecords({
      snapshot: snapshot(),
      reviewItemIds: ["item-0"],
      grantedAt: "2026-08-06T00:00:00.000Z",
      appVersion: "3.6.4",
    });
    expect(records).toEqual([
      expect.objectContaining({
        workspaceIdentity: WORKSPACE,
        hookDeclarationDigest: DIGEST_A,
        sourceDiscoveryOrderAtGrant: 0,
        matcherAtGrant: "startup",
        matcherIndexAtGrant: 0,
        hookIndexAtGrant: 0,
      }),
    ]);
    expect(() =>
      createWorkspaceHookTrustRecords({
        snapshot: snapshot(),
        reviewItemIds: ["renderer-invented-item"],
        grantedAt: "2026-08-06T00:00:00.000Z",
      }),
    ).toThrow("Unknown Workspace Hook review item");
  });

  it("policy provider 读取失败时 fail closed，且 capability 不允许写 Trust", () => {
    const coordinator = new WorkspaceHookTrustCoordinator({
      coordinatorEpoch: "epoch-1",
      policyProvider: {
        getPolicy() {
          throw new Error("managed provider unavailable");
        },
        subscribe() {
          return () => undefined;
        },
      },
    });
    const evaluation = coordinator.evaluateSnapshot({ snapshot: snapshot() });
    expect(evaluation.policy).toMatchObject({ mode: "deny" });
    expect(evaluation.items[0]).toMatchObject({
      trustState: "blocked_policy",
      effectiveRunnable: false,
    });
    expect(() => coordinator.assertPersistentTrustMutationAllowed(WORKSPACE)).toThrow(
      "does not allow persistent Trust mutation",
    );
  });

  it("store 损坏 fail closed，精确 slot 的旧 record 显示 stale_digest", () => {
    const coordinator = new WorkspaceHookTrustCoordinator({ coordinatorEpoch: "epoch-1" });
    coordinator.replacePersistentTrustRecords([record()], { status: "ok" });
    const changed = snapshot([{ digest: DIGEST_B, command: "echo changed", hookIndex: 0 }]);
    expect(coordinator.evaluateSnapshot({ snapshot: changed }).items[0]).toMatchObject({
      trustState: "stale_digest",
      effectiveRunnable: false,
    });

    coordinator.replacePersistentTrustRecords([], {
      status: "corrupt",
      recoveredCorruptPath: "/security/store.corrupt-1",
    });
    const evaluation = coordinator.evaluateSnapshot({ snapshot: snapshot() });
    expect(evaluation.storeStatus).toBe("corrupt");
    expect(evaluation.reasonCode).toBe("workspace_hooks_trust_store_corrupt");
    expect(evaluation.items[0]).toMatchObject({
      trustState: "blocked_untrusted",
      effectiveRunnable: false,
    });
  });
});
