import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelConfigRules, ProviderConfig, ProviderConfigMap } from "@zcode/provider";
import { atomicWritePrivateTextFile, withFileLock } from "@zcode/shared/node";
import {
  NodePersonalProviderConfigRepository,
  encodeProviderConfigFile,
} from "@zcode/provider-node";

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, readFile: vi.fn(fs.readFile), mkdir: vi.fn(fs.mkdir), rename: vi.fn(fs.rename) };
});

let directory: string;
let filePath: string;
const repositories: NodePersonalProviderConfigRepository[] = [];
const pendingReads: Promise<unknown>[] = [];
const releases: Array<() => void> = [];

function config(id: string) {
  return {
    providers: new ProviderConfigMap([[id, new ProviderConfig({ personalModelIds: [id] })]]),
    models: ModelConfigRules.empty(),
    defaultModelSelection: { providerId: id, modelId: id },
  };
}

function repository(
  options: Partial<ConstructorParameters<typeof NodePersonalProviderConfigRepository>[0]> = {},
) {
  const result = new NodePersonalProviderConfigRepository({
    filePath,
    pollingIntervalMs: false,
    ...options,
  });
  repositories.push(result);
  return result;
}

async function holdLock() {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  releases.push(release.resolve);
  const done = withFileLock(filePath, async () => {
    entered.resolve();
    await release.promise;
  });
  pendingReads.push(done);
  await entered.promise;
  return { release: release.resolve, done };
}

async function pauseNextRead(failure?: Error) {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  releases.push(release.resolve);
  vi.mocked(readFile).mockImplementationOnce(async (...args) => {
    try {
      const content = await actual.readFile(...args);
      if (failure) throw failure;
      return content;
    } finally {
      entered.resolve();
      await release.promise;
    }
  });
  return { entered: entered.promise, release: release.resolve };
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "provider-read-lock-"));
  filePath = join(directory, "provider_config.json");
  await writeFile(filePath, JSON.stringify(encodeProviderConfigFile(config("original"))));
  vi.clearAllMocks();
});

afterEach(async () => {
  repositories.splice(0).forEach((repo) => repo.dispose());
  releases.splice(0).forEach((release) => release());
  await Promise.allSettled(pendingReads.splice(0));
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

describe("Personal 配置纯读取与写锁边界", () => {
  it("正常读取不创建锁元数据，即使另一个 writer 持锁也返回已提交配置", async () => {
    const held = await holdLock();
    vi.mocked(mkdir).mockClear();
    const reader = repository();
    let result: Awaited<ReturnType<typeof reader.read>> | undefined;
    const read = reader.read().then((value) => {
      result = value;
    });
    pendingReads.push(read);
    await vi.waitFor(() => expect(result?.providers.keys()).toEqual(["original"]), {
      timeout: 500,
    });
    expect(result?.defaultModelSelection).toEqual({ providerId: "original", modelId: "original" });
    expect(mkdir).not.toHaveBeenCalled();
    expect(await readdir(`${filePath}.lock`)).toHaveLength(1);
    held.release();
    await held.done;
  });

  it("轮询在 writer 尚未释放锁时观察完整的新文档，不创建自己的锁", async () => {
    const reader = repository({ pollingIntervalMs: 10 });
    await reader.read();
    const reasons: string[] = [];
    reader.onDidChange((reason) => reasons.push(reason));
    const held = await holdLock();
    await atomicWritePrivateTextFile(
      filePath,
      JSON.stringify(encodeProviderConfigFile(config("external"))),
    );
    vi.mocked(mkdir).mockClear();
    await vi.waitFor(() => expect(reasons).toContain("poll-changed"), { timeout: 500 });
    expect(mkdir).not.toHaveBeenCalled();
    expect((await reader.read()).defaultModelSelection?.providerId).toBe("external");
    held.release();
    await held.done;
  });

  it.each(["missing", "noncanonical"] as const)(
    "%s 文件等待写锁后重读，不用旧内容覆盖其他 writer",
    async (kind) => {
      if (kind === "missing") await rm(filePath);
      else {
        const document = encodeProviderConfigFile(config("original"));
        await writeFile(filePath, JSON.stringify({ config: document.config, schemaVersion: 1 }));
      }
      const importer = vi.fn(async () => config("legacy"));
      const reader = repository({ importLegacy: importer });
      const held = await holdLock();
      const paused = await pauseNextRead();
      const read = reader.read();
      pendingReads.push(read);
      await paused.entered;
      await atomicWritePrivateTextFile(
        filePath,
        JSON.stringify(encodeProviderConfigFile(config("newer"))),
      );
      paused.release();
      held.release();
      await held.done;
      expect((await read).providers.keys()).toEqual(["newer"]);
      expect(importer).not.toHaveBeenCalled();
      expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual(
        encodeProviderConfigFile(config("newer")),
      );
    },
  );

  it("规范化确实需要写回时仍然使用写锁", async () => {
    const document = encodeProviderConfigFile(config("original"));
    await writeFile(filePath, JSON.stringify({ config: document.config, schemaVersion: 1 }));
    const reader = repository();
    await reader.read();
    expect(vi.mocked(mkdir).mock.calls.some(([path]) => path === `${filePath}.lock`)).toBe(true);
    expect(await readFile(filePath, "utf8")).toBe(JSON.stringify(document, null, 2));
  });

  it("慢轮询期间显式读取不会再启动一轮轮询", async () => {
    const reader = repository({ pollingIntervalMs: 10 });
    await reader.read();
    const paused = await pauseNextRead();
    await paused.entered;
    const callsBefore = vi.mocked(readFile).mock.calls.length;
    const read = reader.read();
    pendingReads.push(read);
    await read;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(vi.mocked(readFile).mock.calls.length).toBe(callsBefore + 1);
    paused.release();
  });

  it("旧轮询晚返回不能把本 Repository 新提交的版本倒退或重复发布", async () => {
    const reader = repository({ pollingIntervalMs: 10 });
    await reader.read();
    const reasons: string[] = [];
    reader.onDidChange((reason) => reasons.push(reason));
    const paused = await pauseNextRead();
    await paused.entered;
    const write = reader.update(() => config("newer"));
    pendingReads.push(write);
    await write;
    paused.release();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(reasons).toEqual(["updated"]);
    expect((await reader.read()).providers.keys()).toEqual(["newer"]);
  });

  it("真实独立 Node 读者在父进程持续持有写锁时仍可读取完整配置", async () => {
    const held = await holdLock();
    const script = fileURLToPath(new URL("./fixtures/personal-config-reader.ts", import.meta.url));
    const child = fork(script, [filePath], {
      execArgv: ["--import", import.meta.resolve("tsx")],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const exited = new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(`reader child ${code}: ${stderr}`)),
      );
    });
    void exited.catch(() => undefined);
    let received: unknown;
    child.on("message", (message) => {
      received = message;
    });
    try {
      await vi.waitFor(
        () =>
          expect(received).toEqual({
            providers: ["original"],
            defaultModelSelection: { providerId: "original", modelId: "original" },
          }),
        { timeout: 5_000 },
      );
      await exited;
      expect(await readdir(`${filePath}.lock`)).toHaveLength(1);
    } finally {
      held.release();
      await held.done;
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await Promise.allSettled([exited]);
    }
  });

  it("旧轮询的失败晚于成功保存返回时同样丢弃，不发布过期故障", async () => {
    const reader = repository({ pollingIntervalMs: 10 });
    await reader.read();
    const reasons: string[] = [];
    reader.onDidChange((reason) => reasons.push(reason));
    const paused = await pauseNextRead(
      Object.assign(new Error("delayed read failure"), { code: "EIO" }),
    );
    await paused.entered;
    await reader.update(() => config("newer"));
    paused.release();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(reasons).toEqual(["updated"]);
  });

  it("实际保存失败仍拒绝操作、保留原文，不发布成功变更", async () => {
    const reader = repository();
    const original = await readFile(filePath, "utf8");
    const changed = vi.fn();
    reader.onDidChange(changed);
    vi.mocked(rename).mockRejectedValueOnce(
      Object.assign(new Error("disk full"), { code: "ENOSPC" }),
    );
    await expect(reader.update(() => config("newer"))).rejects.toMatchObject({ code: "ENOSPC" });
    expect(await readFile(filePath, "utf8")).toBe(original);
    expect(changed).not.toHaveBeenCalled();
    expect(await readdir(directory)).toEqual(["provider_config.json"]);
  });
});
