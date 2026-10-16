import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NodeProviderConfigRuntime } from "../src/provider-config-runtime.js";
import { decodeZCodeBuiltinRelease } from "../src/zcode-builtin-release.js";

const release = {
  schemaVersion: 1,
  revision: 1,
  config: {
    providerConfigRules: { templateRules: [], providerRules: [] },
    modelConfigRules: {
      modelRules: [],
      modelApiRules: [],
      providerSiteRules: [],
      templateModelRules: [],
      builtinProviderModelRules: [],
    },
  },
};
const roots: string[] = [];
const disposers: (() => void)[] = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) dispose();
  vi.useRealTimers();
  // dispose 中止进行中的下载后，同步器仍会异步加锁写 control.json 释放租约（cancelled）；
  // 直接删除临时目录会与锁文件和原子写竞争，偶发 ENOTEMPTY。以控制文件的租约释放为准等收尾完成。
  await Promise.all(roots.map((root) => vi.waitFor(() => expectLeaseReleased(root))));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function expectLeaseReleased(root: string) {
  const control = await readFile(join(root, "control.json"), "utf8").catch(() => null);
  expect(control === null ? 0 : (JSON.parse(control) as { leaseUntil: number }).leaseUntil).toBe(0);
  await expect(stat(join(root, "control.json.lock"))).rejects.toThrow();
}

async function setup(
  fetchRelease: (
    endpoint: string,
    signal: AbortSignal,
  ) => Promise<ReturnType<typeof decodeZCodeBuiltinRelease> | null>,
) {
  const root = await mkdtemp(join(tmpdir(), "builtin-lifecycle-"));
  roots.push(root);
  const bundled = join(root, "bundled.json");
  await writeFile(bundled, JSON.stringify(release));
  const runtime = new NodeProviderConfigRuntime({
    zcodeBuiltinFilePath: bundled,
    zcodeBuiltinActiveFilePath: join(root, "active.json"),
    personalFilePath: join(root, "personal.json"),
    watch: false,
    personalPollingIntervalMs: false,
    zcodeBuiltinRemote: {
      controlFilePath: join(root, "control.json"),
      resolveEndpointKey: () => "https://example.com",
      fetchRelease,
    },
    onZCodeBuiltinRefreshError: () => {},
  });
  disposers.push(() => runtime.dispose());
  return runtime;
}

describe("Built-in 环境生命周期检查", () => {
  it("每分钟检查，一小时 TTL 不重复下载，但 Account 恢复每次可运行", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const fetchRelease = vi.fn(async () => null);
    const runtime = await setup(fetchRelease);
    const recovery = vi.fn(async () => {});
    runtime.onDidCheckZCodeBuiltin(recovery);
    await runtime.start();
    await runtime.refreshZCodeBuiltin();
    await vi.waitFor(() => expect(recovery).toHaveBeenCalledTimes(1));
    expect(fetchRelease).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(recovery).toHaveBeenCalledTimes(2));
    expect(fetchRelease).toHaveBeenCalledTimes(1);
    for (let minute = 0; minute < 59; minute++) {
      await vi.advanceTimersByTimeAsync(60_000);
      await runtime.refreshZCodeBuiltin();
    }
    await vi.waitFor(() => expect(fetchRelease).toHaveBeenCalledTimes(2));
    runtime.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("失败退避到期才下载，失败不阻止 Account 恢复；dispose 取消进行中请求", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    let signal: AbortSignal | undefined;
    const fetchRelease = vi.fn(async (_endpoint: string, value: AbortSignal) => {
      signal = value;
      throw new Error("offline");
    });
    const runtime = await setup(fetchRelease);
    const recovery = vi.fn(async () => {});
    runtime.onDidCheckZCodeBuiltin(recovery);
    await runtime.start();
    await runtime.refreshZCodeBuiltin().catch(() => {});
    await vi.waitFor(() => expect(recovery).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(fetchRelease).toHaveBeenCalledTimes(2));
    await runtime.refreshZCodeBuiltin().catch(() => {});
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(recovery).toHaveBeenCalledTimes(3));
    expect(fetchRelease).toHaveBeenCalledTimes(2);
    fetchRelease.mockImplementation(async (_endpoint, value) => {
      signal = value;
      return new Promise((resolve) =>
        value.addEventListener("abort", () => resolve(null), { once: true }),
      );
    });
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(fetchRelease).toHaveBeenCalledTimes(3));
    runtime.dispose();
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
