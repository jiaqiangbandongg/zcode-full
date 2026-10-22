import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { atomicWritePrivateTextFile, withFileLock } from "@zcode/shared/node";
import { createCredentialService } from "#src/credential/credentialService.js";
import { setDataBaseDir } from "#src/paths.js";

const key = "project-key-location:v1:synthetic-scope";
const location = JSON.stringify({ organizationId: "org", projectId: "project", apiKeyId: "key" });
let root: string;
let file: string;
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "zcode-cache-recovery-"));
  setDataBaseDir(root);
  file = join(root, ".zcode", "v2", "credentials.json");
});
afterEach(async () => {
  setDataBaseDir(null);
  await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const onDidMutate = vi.fn();
  const service = createCredentialService({ onDidMutate });
  await service.save("oauth:active_provider", "bigmodel");
  await service.save("oauth:bigmodel:access_token", "valid-login");
  await service.save("bot:test:credential", "independent");
  await service.save(key, location);
  const healthy = JSON.parse(await readFile(file, "utf8"));
  await writeFile(file, JSON.stringify({ ...healthy, [key]: "enc:v1:broken" }));
  onDidMutate.mockClear();
  return { service, onDidMutate, healthy };
}

describe("本地缓存恢复的原子边界", () => {
  it("两个实例并发只删除一次坏缓存，OAuth 和独立凭据逐字节保留", async () => {
    const f = await fixture();
    const other = createCredentialService({ onDidMutate: f.onDidMutate });
    expect(
      await Promise.all([
        f.service.recoverUnreadable(key, () => {}),
        other.recoverUnreadable(key, () => {}),
      ]),
    ).toEqual([null, null]);
    const after = JSON.parse(await readFile(file, "utf8"));
    for (const [name, value] of Object.entries(f.healthy))
      if (name !== key) expect(after[name]).toBe(value);
    expect(after[key]).toBeUndefined();
    expect(f.onDidMutate.mock.calls).toEqual([[{ operation: "delete", key }]]);
  });

  it("另一写入先修复时，锁内重读返回修复值，不删除新记录", async () => {
    const f = await fixture();
    const entered = deferred(),
      release = deferred();
    const writer = withFileLock(file, async () => {
      entered.resolve();
      await release.promise;
      await atomicWritePrivateTextFile(file, JSON.stringify(f.healthy));
    });
    await entered.promise;
    const recovery = f.service.recoverUnreadable(key, () => {});
    release.resolve();
    await writer;
    expect(await recovery).toBe(location);
    expect(await f.service.load(key)).toBe(location);
    expect(f.onDidMutate).not.toHaveBeenCalled();
  });

  it("另一实例提交新登录并修复位置后，旧恢复不修改任何记录", async () => {
    const f = await fixture();
    const other = createCredentialService();
    await other.save("oauth:bigmodel:access_token", "new-login");
    await other.save(key, location);
    const before = await readFile(file, "utf8");
    expect(await f.service.recoverUnreadable(key, () => {})).toBe(location);
    expect(await readFile(file, "utf8")).toBe(before);
    expect(await other.load("oauth:bigmodel:access_token")).toBe("new-login");
  });

  it("等待锁期间请求失效，提交前拒绝恢复且文件不变", async () => {
    const f = await fixture();
    const before = await readFile(file, "utf8");
    const entered = deferred(),
      release = deferred();
    let current = true;
    const holder = withFileLock(file, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const recovery = f.service.recoverUnreadable(key, () => {
      if (!current) throw new Error("invalidated");
    });
    const rejected = expect(recovery).rejects.toThrow("invalidated");
    current = false;
    release.resolve();
    await holder;
    await rejected;
    expect(await readFile(file, "utf8")).toBe(before);
    expect(f.onDidMutate).not.toHaveBeenCalled();
  });

  it("完整 JSON 已损坏时拒绝恢复，保留原文件", async () => {
    const f = await fixture();
    await writeFile(file, "{broken-json");
    await expect(f.service.recoverUnreadable(key, () => {})).rejects.toThrow(
      "credentials are corrupt",
    );
    expect(await readFile(file, "utf8")).toBe("{broken-json");
    expect(f.onDidMutate).not.toHaveBeenCalled();
  });

  it.each(["save", "delete"] as const)(
    "%s 等待共享锁期间失效，不能提交旧缓存操作",
    async (operation) => {
      const f = await fixture();
      const before = await readFile(file, "utf8");
      const entered = deferred(),
        release = deferred();
      let current = true;
      const holder = withFileLock(file, async () => {
        entered.resolve();
        await release.promise;
      });
      await entered.promise;
      const guard = () => {
        if (!current) throw new Error("invalidated");
      };
      const pending =
        operation === "save" ? f.service.save(key, location, guard) : f.service.delete(key, guard);
      const rejected = expect(pending).rejects.toThrow("invalidated");
      current = false;
      release.resolve();
      await holder;
      await rejected;
      expect(await readFile(file, "utf8")).toBe(before);
      expect(f.onDidMutate).not.toHaveBeenCalled();
    },
  );
});
