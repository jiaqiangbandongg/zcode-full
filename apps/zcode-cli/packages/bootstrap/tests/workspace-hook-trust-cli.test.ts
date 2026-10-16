import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  grantWorkspaceHookTrust,
  inspectWorkspaceHookTrust,
  revokeWorkspaceHookTrustCli,
} from "../src/workspace-hook-trust-cli.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "zcode-hook-trust-cli-"));
  roots.push(root);
  const workspacePath = join(root, "workspace");
  const storagePath = join(root, "user-data");
  const userConfigPath = join(root, "config.json");
  await mkdir(join(workspacePath, ".zcode"), { recursive: true });
  await writeFile(
    userConfigPath,
    JSON.stringify({ storage: { dir: storagePath }, hooks: { enabled: true, events: {} } }),
  );
  await writeFile(
    join(workspacePath, ".zcode", "config.json"),
    JSON.stringify({
      hooks: {
        enabled: true,
        events: {
          SessionStart: [
            {
              matcher: "startup",
              hooks: [{ type: "command", command: "./start.sh" }],
            },
          ],
        },
      },
    }),
  );
  return { storagePath, workspacePath, userConfigPath };
}

describe("Workspace Hook Trust CLI domain", () => {
  it("status exposes exact bundle/declaration digests and exact grant/revoke persists", async () => {
    const target = await fixture();
    const pending = await inspectWorkspaceHookTrust(target);
    expect(pending.reasonCode).toBe("workspace_hooks_pending_trust");
    expect(pending.bundleDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(pending.items).toHaveLength(1);
    const digest = pending.items[0]!.hookDeclarationDigest;

    const granted = await grantWorkspaceHookTrust({
      ...target,
      hookDeclarationDigests: [digest],
      appVersion: "test",
    });
    expect(granted.reasonCode).toBe("workspace_hooks_trusted_persistent");
    expect(granted.items[0]?.trustState).toBe("trusted_persistent");

    const revoked = await revokeWorkspaceHookTrustCli({
      ...target,
      hookDeclarationDigests: [digest],
    });
    expect(revoked.reasonCode).toBe("workspace_hooks_pending_trust");
  });

  it("all-current rejects a stale bundle without writing Trust", async () => {
    const target = await fixture();
    await expect(
      grantWorkspaceHookTrust({
        ...target,
        allCurrent: true,
        bundleDigest: "f".repeat(64),
      }),
    ).rejects.toThrow("workspace_hooks_bundle_changed");
    expect((await inspectWorkspaceHookTrust(target)).items[0]?.trustState).toBe("pending_trust");
  });

  it("exact grant rejects a stale Settings bundle before writing Trust", async () => {
    const target = await fixture();
    const pending = await inspectWorkspaceHookTrust(target);
    await expect(
      grantWorkspaceHookTrust({
        ...target,
        bundleDigest: "f".repeat(64),
        hookDeclarationDigests: [pending.items[0]!.hookDeclarationDigest],
      }),
    ).rejects.toThrow("workspace_hooks_bundle_changed");
    expect((await inspectWorkspaceHookTrust(target)).items[0]?.trustState).toBe("pending_trust");
  });

  it("corrupt Trust store rejects the first grant instead of silently replacing it", async () => {
    const target = await fixture();
    const pending = await inspectWorkspaceHookTrust(target);
    const securityPath = join(target.storagePath, "security");
    await mkdir(securityPath, { recursive: true });
    await writeFile(join(securityPath, "workspace-hook-trust-v1.json"), "{ invalid json");

    await expect(
      grantWorkspaceHookTrust({
        ...target,
        bundleDigest: pending.bundleDigest!,
        hookDeclarationDigests: [pending.items[0]!.hookDeclarationDigest],
      }),
    ).rejects.toThrow("workspace_hooks_trust_store_corrupt");
  });

  // SG-02 回归：status 对损坏 store 必须显式报 corrupt，不能伪装成 pending_trust——
  // 否则用户按提示执行 grant 只会得到 trust_store_corrupt，恢复指引自相矛盾。
  it("status surfaces corrupt Trust store as its own reasonCode instead of pending_trust", async () => {
    const target = await fixture();
    const securityPath = join(target.storagePath, "security");
    await mkdir(securityPath, { recursive: true });
    // JSON 合法但结构非法（缺 schemaVersion/必需字段），schema 校验失败同样 corrupt。
    await writeFile(
      join(securityPath, "workspace-hook-trust-v1.json"),
      JSON.stringify({ schemaVersion: 1, records: [{ workspaceIdentity: "/anywhere" }] }),
    );

    const status = await inspectWorkspaceHookTrust(target);
    expect(status.reasonCode).toBe("workspace_hooks_trust_store_corrupt");
    // corrupt 下任何 digest 都不可信：全部条目不得展示 trusted_persistent。
    for (const item of status.items) {
      expect(item.trustState).toBe("pending_trust");
    }
  });
});
