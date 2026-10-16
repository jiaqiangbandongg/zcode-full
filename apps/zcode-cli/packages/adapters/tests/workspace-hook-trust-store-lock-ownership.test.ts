import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkspaceHookTrustRecord } from "@zcode/contracts";
import { createFileWorkspaceHookTrustStore } from "../src/storage/workspace-hook-trust-store.js";

/**
 * 锁所有权与 stale 回收（CR-02 回归）。
 *
 * Bug 背景：锁仅依赖固定 .lock 路径 + mtime，锁内容为空、释放时无条件
 * unlink，stale 回收仅看年龄。两条危害链：
 * 1. 持锁进程 A 被系统休眠/调试暂停超过 staleLockMs 后恢复，其 finally
 *    无条件 unlink 会删掉"回收后新持有者 B"的锁，第三个 writer C 得以
 *    与 B 并发进入临界区。
 * 2. mtime 无法区分"持有者死亡"与"持有者暂停或慢"——A 只是慢就会被 B
 *    误回收，A/B 基于不同旧快照 read-modify-write，已提交的 revoke 可能
 *    被旧 grant 快照恢复。
 *
 * 修复契约：
 * 1. 锁内容写入 {pid, token}；释放前重读并验证 token，不是自己的锁绝不删。
 * 2. stale 回收前做 pid 存活检测：持有进程仍存活则不回收（等它自行释放）；
 *    无法解析（旧版空锁）或 pid 已死才回收。
 */

const roots: string[] = [];
const DIGEST_A = "a".repeat(64);
const DEAD_PID = 999_999_999; // 远超典型 pid 上限，进程不存在的概率趋近 1

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "zcode-hook-store-lock-"));
  roots.push(value);
  return value;
}

function record(workspaceIdentity: string, digest: string): WorkspaceHookTrustRecord {
  return {
    workspaceIdentity,
    hookDeclarationDigest: digest,
    digestAlgorithm: "sha256",
    decision: "trusted",
    grantedAt: "2026-08-06T00:00:00.000Z",
    eventAtGrant: "SessionStart",
    displayCommandAtGrant: "echo trusted",
    sourcePathAtGrant: ".zcode/config.json",
    sourceDiscoveryOrderAtGrant: 0,
    matcherAtGrant: "startup",
    matcherIndexAtGrant: 0,
    hookIndexAtGrant: 0,
  };
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function ageLockBeyond(lockPath: string, staleLockMs: number): Promise<void> {
  const staleTime = new Date(Date.now() - staleLockMs * 12);
  await utimes(lockPath, staleTime, staleTime);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

describe("FileWorkspaceHookTrustStore lock ownership（CR-02）", () => {
  it("契约 3a（CR-01）：pid 存活但启动时间不一致（PID 复用）→ 超龄锁必须被回收", async () => {
    const dir = await root();
    const filePath = join(dir, "workspace-hook-trust-v1.json");
    const lockPath = `${filePath}.lock`;

    // 用一个真实存活的外部进程模拟「pid 被复用给无关进程」：锁记录的 pid
    // 当前存活（该子进程），但锁内 startTime 属于早已死去的原实例。
    const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 60000)"], {
      stdio: "ignore",
    });
    try {
      const reusedStartTime = Date.now() - 86_400_000;
      await writeFile(
        lockPath,
        `${JSON.stringify({ pid: sleeper.pid, startTime: reusedStartTime, token: "dead-original" })}\n`,
        "utf8",
      );
      await ageLockBeyond(lockPath, 5_000);

      // 注入 identity probe：报告该 pid 当前实例的真实启动时间（与锁内不同）。
      const storeB = createFileWorkspaceHookTrustStore({
        filePath,
        staleLockMs: 5_000,
        lockTimeoutMs: 5_000,
        probeProcessStartTime: async () => Date.now() - 1_000,
      });
      await storeB.grant([record("/ws/owner-b", DIGEST_A)]);

      const loaded = await storeB.load();
      expect(loaded.status).toBe("ok");
      await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      sleeper.kill();
      await new Promise((resolve) => {
        sleeper.once("exit", resolve);
        setTimeout(resolve, 2_000);
      });
    }
  });

  it("契约 3b：pid 存活且启动时间一致（原实例仍活着）→ 不回收", async () => {
    const dir = await root();
    const filePath = join(dir, "workspace-hook-trust-v1.json");
    const lockPath = `${filePath}.lock`;

    const originalStart = Date.now() - 10_000;
    await writeFile(
      lockPath,
      `${JSON.stringify({ pid: process.pid, startTime: originalStart, token: "slow-but-alive" })}\n`,
      "utf8",
    );
    await ageLockBeyond(lockPath, 5_000);

    const storeB = createFileWorkspaceHookTrustStore({
      filePath,
      staleLockMs: 5_000,
      lockTimeoutMs: 300,
      probeProcessStartTime: async () => originalStart,
    });
    await expect(storeB.grant([record("/ws/owner-b", DIGEST_A)])).rejects.toThrow(
      /Timed out acquiring/,
    );
  });

  it("契约 3c：identity probe 不可用（null）→ 保守不回收，行为与旧版一致", async () => {
    const dir = await root();
    const filePath = join(dir, "workspace-hook-trust-v1.json");
    const lockPath = `${filePath}.lock`;

    await writeFile(
      lockPath,
      `${JSON.stringify({ pid: process.pid, startTime: Date.now() - 60_000, token: "probe-less" })}\n`,
      "utf8",
    );
    await ageLockBeyond(lockPath, 5_000);

    const storeB = createFileWorkspaceHookTrustStore({
      filePath,
      staleLockMs: 5_000,
      lockTimeoutMs: 300,
      probeProcessStartTime: async () => null,
    });
    await expect(storeB.grant([record("/ws/owner-b", DIGEST_A)])).rejects.toThrow(
      /Timed out acquiring/,
    );
  });

  it("契约 4：owner metadata 写入失败 → 不残留空锁与句柄", async () => {
    const dir = await root();
    const filePath = join(dir, "workspace-hook-trust-v1.json");
    const lockPath = `${filePath}.lock`;

    const store = createFileWorkspaceHookTrustStore({
      filePath,
      writeLockOwnerMetadata: async () => {
        throw new Error("disk full while writing lock metadata");
      },
    });
    await expect(store.grant([record("/ws/owner-b", DIGEST_A)])).rejects.toThrow(
      /disk full/,
    );
    // 关键：open("wx") 成功但 metadata 写失败后，必须清理自己刚建的空锁，
    // 否则下一个 writer 会读到一个无法解析的无主锁。
    await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });

    // 清理后后续 mutation 可正常进行。
    const retry = createFileWorkspaceHookTrustStore({ filePath });
    await retry.grant([record("/ws/owner-b", DIGEST_A)]);
    const loaded = await retry.load();
    expect(loaded.status).toBe("ok");
  });

  it("契约 1：被回收后恢复的旧 owner 不得删除新持有者的锁", async () => {
    const dir = await root();
    const filePath = join(dir, "workspace-hook-trust-v1.json");
    const lockPath = `${filePath}.lock`;

    // A 持锁暂停在临界区内（rename 前）。
    const writerAHold = deferred<void>();
    const releaseWriterA = deferred<void>();
    const storeA = createFileWorkspaceHookTrustStore({
      filePath,
      beforeRename: async () => {
        writerAHold.resolve();
        await releaseWriterA.promise;
      },
    });
    const grantA = storeA.grant([record("/ws/owner-a", DIGEST_A)]);
    await writerAHold.promise;

    // 模拟 A 的锁已被 stale 回收、B 建立了新锁（不同 pid + token）：
    // 直接覆写锁文件内容为 B 的持有信息。
    const lockOfB = `${JSON.stringify({ pid: DEAD_PID, token: "owner-b-token" })}\n`;
    await writeFile(lockPath, lockOfB, "utf8");

    // 放行 A：其 finally 不得删除 B 的锁。
    releaseWriterA.resolve();
    await grantA;

    const lockContent = await readFile(lockPath, "utf8");
    expect(lockContent).toBe(lockOfB);
  });

  it("契约 2a：超龄但持有进程存活的锁不得被回收（暂停 ≠ 死亡）", async () => {
    const dir = await root();
    const filePath = join(dir, "workspace-hook-trust-v1.json");
    const lockPath = `${filePath}.lock`;

    // 手写一把"活着但超龄"的锁：pid = 本进程（存活）。
    await writeFile(
      lockPath,
      `${JSON.stringify({ pid: process.pid, token: "slow-but-alive" })}\n`,
      "utf8",
    );
    await ageLockBeyond(lockPath, 5_000);

    // 另一 writer 在 lockTimeoutMs 内必须拿不到锁（不回收活锁）。
    const storeB = createFileWorkspaceHookTrustStore({
      filePath,
      staleLockMs: 5_000,
      lockTimeoutMs: 300,
    });
    await expect(storeB.grant([record("/ws/owner-b", DIGEST_A)])).rejects.toThrow(
      /Timed out acquiring/,
    );
    // 锁原样保留。
    expect(await readFile(lockPath, "utf8")).toContain("slow-but-alive");
  });

  it("契约 2b：持有进程已死亡的超龄锁正常回收，mutation 不被卡死", async () => {
    const dir = await root();
    const filePath = join(dir, "workspace-hook-trust-v1.json");
    const lockPath = `${filePath}.lock`;

    // 手写一把"死亡且超龄"的锁（崩溃残留）。
    await writeFile(
      lockPath,
      `${JSON.stringify({ pid: DEAD_PID, token: "dead-owner" })}\n`,
      "utf8",
    );
    await ageLockBeyond(lockPath, 5_000);

    const storeB = createFileWorkspaceHookTrustStore({
      filePath,
      staleLockMs: 5_000,
      lockTimeoutMs: 5_000,
    });
    await storeB.grant([record("/ws/owner-b", DIGEST_A)]);

    const loaded = await storeB.load();
    expect(loaded.status).toBe("ok");
    await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("契约 2c：旧版本空锁（无 pid 可查）超龄后仍按无主回收，升级不卡死", async () => {
    const dir = await root();
    const filePath = join(dir, "workspace-hook-trust-v1.json");
    const lockPath = `${filePath}.lock`;

    await writeFile(lockPath, "", "utf8");
    await ageLockBeyond(lockPath, 5_000);

    const store = createFileWorkspaceHookTrustStore({
      filePath,
      staleLockMs: 5_000,
      lockTimeoutMs: 5_000,
    });
    await store.grant([record("/ws/upgraded", DIGEST_A)]);
    await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("正常串行 mutation：锁写入并验证所有权后清理，行为不变", async () => {
    const dir = await root();
    const filePath = join(dir, "workspace-hook-trust-v1.json");
    const lockPath = `${filePath}.lock`;
    const store = createFileWorkspaceHookTrustStore({ filePath });

    await store.grant([record("/ws/token", DIGEST_A)]);

    await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    const loaded = await store.load();
    expect(loaded.status).toBe("ok");
  });

  it("并发 grant/revoke 多 writer：已撤销的记录不得被旧 grant 快照恢复", async () => {
    const dir = await root();
    const filePath = join(dir, "workspace-hook-trust-v1.json");

    const seed = createFileWorkspaceHookTrustStore({ filePath });
    await seed.grant([record("/ws/victim", DIGEST_A)]);

    const writers = ["/ws/w1", "/ws/w2", "/ws/w3"].map((identity, index) =>
      createFileWorkspaceHookTrustStore({
        filePath,
        staleLockMs: 1,
        lockTimeoutMs: 10_000,
      }).grant([record(identity, `${String(index + 1).repeat(64)}`)]),
    );
    const revoker = createFileWorkspaceHookTrustStore({
      filePath,
      staleLockMs: 1,
      lockTimeoutMs: 10_000,
    }).revoke({ workspaceIdentity: "/ws/victim" });

    await Promise.all([...writers, revoker]);

    const final = await createFileWorkspaceHookTrustStore({ filePath }).load();
    expect(final.status).toBe("ok");
    if (final.status !== "ok") return;
    expect(
      final.records.some((item) => item.workspaceIdentity === "/ws/victim"),
    ).toBe(false);
    expect(final.records).toHaveLength(3);
  });
});
