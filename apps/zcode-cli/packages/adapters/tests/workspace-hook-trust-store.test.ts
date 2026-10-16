import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceHookTrustRecord } from "@zcode/contracts";
import {
  createFileWorkspaceHookTrustStore,
  resolveWorkspaceHookTrustStorePath,
} from "../src/storage/workspace-hook-trust-store.js";

const roots: string[] = [];
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "zcode-workspace-hook-store-"));
  roots.push(value);
  return value;
}

function record(
  workspaceIdentity: string,
  digest: string,
  grantedAt = "2026-08-06T00:00:00.000Z",
): WorkspaceHookTrustRecord {
  return {
    workspaceIdentity,
    hookDeclarationDigest: digest,
    digestAlgorithm: "sha256",
    decision: "trusted",
    grantedAt,
    eventAtGrant: "SessionStart",
    displayCommandAtGrant: "echo trusted",
    sourcePathAtGrant: ".zcode/config.json",
    sourceDiscoveryOrderAtGrant: 0,
    matcherAtGrant: "startup",
    matcherIndexAtGrant: 0,
    hookIndexAtGrant: 0,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

describe("FileWorkspaceHookTrustStore", () => {
  it("只使用 user config storage.dir，不接受 project/env storage 覆盖", async () => {
    const home = await root();
    const custom = join(home, "trusted-user-storage");
    await mkdir(join(home, ".zcode", "cli"), { recursive: true });
    await writeFile(
      join(home, ".zcode", "cli", "config.json"),
      JSON.stringify({ storage: { dir: custom } }),
      "utf8",
    );
    await expect(resolveWorkspaceHookTrustStorePath({ homeDir: home })).resolves.toBe(
      join(custom, "security", "workspace-hook-trust-v1.json"),
    );
  });

  it("selected/all grant 单次原子提交，文件和目录权限保持 user-only", async () => {
    const base = await root();
    const path = join(base, "security", "workspace-hook-trust-v1.json");
    const store = createFileWorkspaceHookTrustStore({ filePath: path });
    await store.grant([record("workspace:a", DIGEST_A), record("workspace:a", DIGEST_B)]);

    const loaded = await store.load();
    expect(loaded.status).toBe("ok");
    expect(loaded.records).toHaveLength(2);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(base, "security"))).mode & 0o777).toBe(0o700);
    expect((await readdir(join(base, "security"))).filter((name) => name.endsWith(".tmp"))).toEqual(
      [],
    );
  });

  it("并发 grant 持锁重读，不丢失任一进程内 mutation", async () => {
    const base = await root();
    const path = join(base, "security", "workspace-hook-trust-v1.json");
    const first = createFileWorkspaceHookTrustStore({ filePath: path });
    const second = createFileWorkspaceHookTrustStore({ filePath: path });

    await Promise.all([
      first.grant([record("workspace:a", DIGEST_A)]),
      second.grant([record("workspace:b", DIGEST_B)]),
    ]);
    const loaded = await first.load();
    expect(loaded.records.map((item) => item.workspaceIdentity).sort()).toEqual([
      "workspace:a",
      "workspace:b",
    ]);
  });

  it("rename 前失败保留原 store，并清理 temp/lock", async () => {
    const base = await root();
    const path = join(base, "security", "workspace-hook-trust-v1.json");
    const healthy = createFileWorkspaceHookTrustStore({ filePath: path });
    await healthy.grant([record("workspace:a", DIGEST_A)]);
    const failing = createFileWorkspaceHookTrustStore({
      filePath: path,
      beforeRename() {
        throw new Error("injected before rename");
      },
    });
    await expect(failing.grant([record("workspace:b", DIGEST_B)])).rejects.toThrow(
      "injected before rename",
    );
    await expect(healthy.load()).resolves.toMatchObject({
      status: "ok",
      records: [{ workspaceIdentity: "workspace:a" }],
    });
    expect(await readdir(join(base, "security"))).toEqual(["workspace-hook-trust-v1.json"]);
  });

  it("损坏文件备份后 fail closed，新的显式 grant 才创建干净 store", async () => {
    const base = await root();
    const path = join(base, "security", "workspace-hook-trust-v1.json");
    await mkdir(join(base, "security"), { recursive: true });
    await chmod(join(base, "security"), 0o700);
    await writeFile(path, "{broken", { encoding: "utf8", mode: 0o600 });
    const store = createFileWorkspaceHookTrustStore({
      filePath: path,
      now: () => 1_786_060_800_000,
    });

    const corrupt = await store.load();
    expect(corrupt).toMatchObject({ status: "corrupt", records: [] });
    expect(corrupt.recoveredCorruptPath).toContain(".corrupt-1786060800000");
    await expect(readFile(corrupt.recoveredCorruptPath!, "utf8")).resolves.toBe("{broken");

    await store.grant([record("workspace:a", DIGEST_A)]);
    await expect(store.load()).resolves.toMatchObject({
      status: "ok",
      records: [
        {
          workspaceIdentity: "workspace:a",
        },
      ],
    });
  });

  it("revoke 与 GC 原子执行，保留 current digest 和刚建立记录", async () => {
    const base = await root();
    const path = join(base, "security", "workspace-hook-trust-v1.json");
    const store = createFileWorkspaceHookTrustStore({ filePath: path });
    await store.grant([
      record("workspace:a", DIGEST_A, "2025-01-01T00:00:00.000Z"),
      record("workspace:a", DIGEST_B, "2026-08-06T00:00:00.000Z"),
    ]);
    await store.revoke({ workspaceIdentity: "workspace:a", hookDeclarationDigests: [DIGEST_A] });
    await store.compact({
      current: [{ workspaceIdentity: "workspace:a", hookDeclarationDigest: DIGEST_B }],
      maxAgeMs: 1,
      maxRecords: 1,
      now: Date.parse("2026-08-06T01:00:00.000Z"),
    });
    const loaded = await store.load();
    expect(loaded.records.map((item) => item.hookDeclarationDigest)).toEqual([DIGEST_B]);
  });

  it("revoke 拒绝空 digest 数组，undefined 仍表示撤销 workspace 全部记录", async () => {
    const base = await root();
    const path = join(base, "security", "workspace-hook-trust-v1.json");
    const store = createFileWorkspaceHookTrustStore({ filePath: path });
    await store.grant([record("workspace:a", DIGEST_A), record("workspace:a", DIGEST_B)]);

    await expect(
      store.revoke({ workspaceIdentity: "workspace:a", hookDeclarationDigests: [] }),
    ).rejects.toThrow("hookDeclarationDigests must be undefined or non-empty");
    await expect(store.load()).resolves.toMatchObject({ status: "ok", records: expect.any(Array) });
    expect((await store.load()).records).toHaveLength(2);

    await store.revoke({ workspaceIdentity: "workspace:a" });
    expect((await store.load()).records).toHaveLength(0);
  });

  it("Windows 短暂占用导致 rename EPERM 时按有界延迟重试", async () => {
    const base = await root();
    const path = join(base, "security", "workspace-hook-trust-v1.json");
    const renameFile = vi
      .fn<typeof rename>()
      .mockRejectedValueOnce(Object.assign(new Error("temporarily busy"), { code: "EPERM" }))
      .mockImplementation(rename);
    const store = createFileWorkspaceHookTrustStore({
      filePath: path,
      renameFile,
      renameRetryDelaysMs: [0],
    });

    await store.grant([record("workspace:a", DIGEST_A)]);

    expect(renameFile).toHaveBeenCalledTimes(2);
    await expect(store.load()).resolves.toMatchObject({
      status: "ok",
      records: [{ hookDeclarationDigest: DIGEST_A }],
    });
  });
});
