import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { NodeZCodeBuiltinProviderConfigSource, decodeZCodeBuiltinRelease } from "../src/index.js";

it("两个真实消费进程观察同一 Active 原子替换，各自发布同版 Account / Registry", async () => {
  const root = await mkdtemp(join(tmpdir(), "builtin-process-"));
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
  const bundled = join(root, "bundled.json");
  const active = join(root, "active.json");
  await writeFile(bundled, JSON.stringify(release));
  const source = new NodeZCodeBuiltinProviderConfigSource({
    bundledFilePath: bundled,
    activeFilePath: active,
    watch: false,
  });
  const children: ChildProcess[] = [];
  const messages: { pid: number; builtin: string; account: string }[] = [];
  try {
    await source.read();
    for (let index = 0; index < 2; index++) {
      const child = fork(
        fileURLToPath(new URL("./fixtures/builtin-registry-observer.ts", import.meta.url)),
        [active, join(root, `personal-${index}.json`)],
        {
          execArgv: ["--import", import.meta.resolve("tsx")],
          stdio: ["ignore", "ignore", "inherit", "ipc"],
        },
      );
      children.push(child);
      child.on("message", (message) => messages.push(message as (typeof messages)[number]));
    }
    await vi.waitFor(() => expect(new Set(messages.map((message) => message.pid)).size).toBe(2), {
      timeout: 10_000,
    });
    await source.applyRemoteRelease(decodeZCodeBuiltinRelease({ ...release, revision: 2 }));
    await vi.waitFor(
      () =>
        expect(
          new Set(
            messages
              .filter((message) => message.builtin.startsWith("zcode-builtin:2:"))
              .map((message) => message.pid),
          ).size,
        ).toBe(2),
      { timeout: 10_000 },
    );
    expect(messages.every((message) => message.builtin === message.account)).toBe(true);
  } finally {
    source.dispose();
    await Promise.all(
      children.map(async (child) => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const exit = once(child, "exit");
        child.kill();
        await exit;
      }),
    );
    await rm(root, { recursive: true, force: true });
  }
}, 25_000);
