import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSharedZCodeCredentialStore } from "../src/auth/shared-credentials.js";
import {
  deletePendingAuthorizationIfOwned,
  loadPendingAuthorization,
  publishPendingAuthorization,
  resolveAuthorizationLeasePath,
  tryAcquireAuthorizationLease,
} from "../src/mcp/oauth-lease.js";

const KEY_PREFIX = "mcp:oauth:c50fd1fa63fb88a233be0688";
const temporaryDirectories: string[] = [];
const spawnedPids: number[] = [];

afterEach(async () => {
  for (const pid of spawnedPids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // 已退出
    }
  }
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function createCredentialsPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "zcode-mcp-oauth-lease-"));
  temporaryDirectories.push(directory);
  return join(directory, "credentials.json");
}

/** 起一个真实的长驻子进程，只为拿到一个确定存活、随后可被杀死的 PID。 */
async function spawnIdleProcess(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], {
    stdio: "ignore",
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  const pid = child.pid;
  if (pid === undefined) throw new Error("Failed to spawn helper process");
  spawnedPids.push(pid);
  return pid;
}

/**
 * 按 `acquireFileLock` 的磁盘格式写一把属于 `pid` 的锁。
 *
 * 跨进程互斥的契约就是这份磁盘布局，因此直接构造它比在子进程里加载 TS 模块更贴近被测行为。
 */
async function writeForeignLease(leasePath: string, pid: number): Promise<void> {
  const lockDirectory = `${leasePath}.lock`;
  await mkdir(lockDirectory, { recursive: true });
  await writeFile(
    join(lockDirectory, `owner-${pid}-foreign.json`),
    `${JSON.stringify({ pid, createdAt: Date.now(), token: `${pid}-foreign` })}\n`,
    "utf-8",
  );
}

describe("MCP OAuth authorization lease", () => {
  it("uses a lease path whose basename is legal on Windows", async () => {
    const credentialsPath = await createCredentialsPath();
    const leasePath = resolveAuthorizationLeasePath(credentialsPath, KEY_PREFIX);

    // credential key prefix 形如 `mcp:oauth:<hash>`；冒号在 Windows 文件名中非法，
    // 直接拼进锁路径会让整个授权流程在 Windows 上失败。
    expect(leasePath).not.toContain(":");
    expect(leasePath.endsWith(".authz")).toBe(true);
  });

  it("grants the lease to exactly one holder and releases it again", async () => {
    const credentialsPath = await createCredentialsPath();
    const first = await tryAcquireAuthorizationLease({
      credentialsFilePath: credentialsPath,
      keyPrefix: KEY_PREFIX,
    });
    expect(first).toBeDefined();

    const second = await tryAcquireAuthorizationLease({
      credentialsFilePath: credentialsPath,
      keyPrefix: KEY_PREFIX,
    });
    expect(second).toBeUndefined();

    await first?.release();
    const third = await tryAcquireAuthorizationLease({
      credentialsFilePath: credentialsPath,
      keyPrefix: KEY_PREFIX,
    });
    expect(third).toBeDefined();
    expect(third?.attemptId).not.toBe(first?.attemptId);
    await third?.release();
  });

  it("does not steal a lease held by a live process, and reclaims it once that process dies", async () => {
    const credentialsPath = await createCredentialsPath();
    const leasePath = resolveAuthorizationLeasePath(credentialsPath, KEY_PREFIX);
    const holderPid = await spawnIdleProcess();
    await writeForeignLease(leasePath, holderPid);

    const contended = await tryAcquireAuthorizationLease({
      credentialsFilePath: credentialsPath,
      keyPrefix: KEY_PREFIX,
    });
    expect(contended).toBeUndefined();

    process.kill(holderPid, "SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Bug 回归：零等待预算会让 `acquireFileLock` 在竞争时直接超时，永远不执行 owner-dead
    // 回收；持锁进程崩溃后授权功能将永久不可用。
    const reclaimed = await tryAcquireAuthorizationLease({
      credentialsFilePath: credentialsPath,
      keyPrefix: KEY_PREFIX,
    });
    expect(reclaimed).toBeDefined();
    await reclaimed?.release();
    await expect(readdir(`${leasePath}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("MCP OAuth pending authorization record", () => {
  it("only lets the owning attempt delete the pending record", async () => {
    const credentialsPath = await createCredentialsPath();
    const credentialStore = createSharedZCodeCredentialStore({
      env: { ZCODE_CREDENTIAL_SECRET: "mcp-oauth-pending-secret" },
      filePath: credentialsPath,
    });
    await publishPendingAuthorization(credentialStore, KEY_PREFIX, {
      attemptId: "attempt-new",
      authorizationUrl: "https://auth.example.test/authorize?state=new",
      baselineGeneration: "generation-0",
      expiresAt: Date.now() + 60_000,
      state: "state-new",
    });

    // Bug 回归：旧 leader 的 finally 若无条件删除 pending，会抹掉新 leader 刚发布的记录，
    // follower 随即失去授权 URL。删除必须按 attempt CAS。
    await expect(
      deletePendingAuthorizationIfOwned(credentialStore, KEY_PREFIX, "attempt-stale"),
    ).resolves.toBe(false);
    await expect(loadPendingAuthorization(credentialStore, KEY_PREFIX)).resolves.toMatchObject({
      attemptId: "attempt-new",
      authorizationUrl: "https://auth.example.test/authorize?state=new",
    });

    await expect(
      deletePendingAuthorizationIfOwned(credentialStore, KEY_PREFIX, "attempt-new"),
    ).resolves.toBe(true);
    await expect(loadPendingAuthorization(credentialStore, KEY_PREFIX)).resolves.toBeUndefined();
  });

  it("hides an expired pending record without deleting it", async () => {
    const credentialsPath = await createCredentialsPath();
    const credentialStore = createSharedZCodeCredentialStore({
      env: { ZCODE_CREDENTIAL_SECRET: "mcp-oauth-pending-expiry-secret" },
      filePath: credentialsPath,
    });
    await publishPendingAuthorization(credentialStore, KEY_PREFIX, {
      attemptId: "attempt-expired",
      authorizationUrl: "https://auth.example.test/authorize?state=expired",
      expiresAt: Date.now() - 1,
      state: "state-expired",
    });

    // TTL 只用于展示过期判断，不承担锁所有权语义：过期记录对读取方不可见，但仍只能由
    // 归属 attempt 清理。
    await expect(loadPendingAuthorization(credentialStore, KEY_PREFIX)).resolves.toBeUndefined();
    await expect(
      deletePendingAuthorizationIfOwned(credentialStore, KEY_PREFIX, "attempt-other"),
    ).resolves.toBe(false);
    await expect(
      deletePendingAuthorizationIfOwned(credentialStore, KEY_PREFIX, "attempt-expired"),
    ).resolves.toBe(true);
  });
});
