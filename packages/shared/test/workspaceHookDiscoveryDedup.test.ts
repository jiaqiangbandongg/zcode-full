import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildWorkspaceHookBundleSnapshot,
  discoverWorkspaceHookConfigPaths,
  readWorkspaceHookProjectSources,
} from "../src/workspace-hook-discovery.js";

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "zcode-hook-dedup-"));
  roots.push(root);
  return root;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("workspace hook config discovery 去重（#10）", () => {
  it("explicit path 与 auto-discovery 重叠时只保留一个条目", () => {
    const workspace = makeRoot();
    mkdirSync(join(workspace, ".git"));
    const configPath = join(workspace, ".zcode", "config.json");
    writeJson(configPath, {
      hooks: {
        enabled: true,
        events: {
          SessionStart: [{ hooks: [{ type: "command", command: "echo hello" }] }],
        },
      },
    });

    // 不传 explicit：auto-discovery 发现一个文件
    const withoutExplicit = discoverWorkspaceHookConfigPaths({
      workingDirectory: workspace,
    });
    expect(withoutExplicit).toHaveLength(1);
    expect(withoutExplicit[0]?.explicitProjectConfig).toBe(false);

    // 传 explicit 且指向同一文件：去重后仍只有一个条目
    const withExplicit = discoverWorkspaceHookConfigPaths({
      workingDirectory: workspace,
      explicitProjectConfigPath: configPath,
    });
    expect(withExplicit).toHaveLength(1);
    // 首次出现者（auto-discovered）保留，explicit 重复条目被丢弃
    expect(withExplicit[0]?.explicitProjectConfig).toBe(false);
    expect(withExplicit[0]?.path).toBe(configPath);
  });

  it("explicit path 指向 auto-discovery 未发现的文件时正常追加", () => {
    const workspace = makeRoot();
    mkdirSync(join(workspace, ".git"));
    writeJson(join(workspace, ".zcode", "config.json"), {
      hooks: {
        enabled: true,
        events: {
          SessionStart: [{ hooks: [{ type: "command", command: "echo hello" }] }],
        },
      },
    });

    // explicit 指向一个额外文件
    const extraPath = join(workspace, "custom-config.json");
    writeJson(extraPath, {
      hooks: {
        enabled: true,
        events: {
          Stop: [{ hooks: [{ type: "command", command: "echo stop" }] }],
        },
      },
    });

    const refs = discoverWorkspaceHookConfigPaths({
      workingDirectory: workspace,
      explicitProjectConfigPath: extraPath,
    });
    expect(refs).toHaveLength(2);
    expect(refs[0]?.explicitProjectConfig).toBe(false);
    expect(refs[1]?.explicitProjectConfig).toBe(true);
    expect(refs[1]?.path).toBe(extraPath);
  });

  it("无 explicit path 时 discovery 结果不变（digest 稳定性）", async () => {
    // 此前引入去重逻辑后，必须确认对无 explicit path 的 workspace 是 no-op，
    // 否则 auto-discovery 产生的 discoveryOrder 变化会使所有既有 trust 记录失效。
    const workspace = makeRoot();
    mkdirSync(join(workspace, ".git"));
    writeJson(join(workspace, ".zcode", "config.json"), {
      hooks: {
        enabled: true,
        events: {
          SessionStart: [{ hooks: [{ type: "command", command: "echo hello" }] }],
        },
      },
    });

    const { sources } = await readWorkspaceHookProjectSources({
      workingDirectory: workspace,
    });

    expect(sources).toHaveLength(1);
    expect(sources[0]?.discoveryOrder).toBe(0);
    expect(sources[0]?.explicitProjectConfig).toBe(false);

    // 构建 bundle snapshot 并确认 digest 可重复（同一输入两次构建结果一致）
    const snapshot1 = buildWorkspaceHookBundleSnapshot({
      workspaceIdentity: workspace,
      workspacePath: workspace,
      sources,
      runtimeRoot: { enabled: true, timeoutMs: 60_000, maxOutputBytes: 32_768 },
    });
    const snapshot2 = buildWorkspaceHookBundleSnapshot({
      workspaceIdentity: workspace,
      workspacePath: workspace,
      sources,
      runtimeRoot: { enabled: true, timeoutMs: 60_000, maxOutputBytes: 32_768 },
    });
    expect(snapshot1.bundleDigest).toBe(snapshot2.bundleDigest);
    expect(snapshot1.bundleDigest).toBeTruthy();
  });

  it("explicit 重叠时 async discovery 也只产生一个 source", async () => {
    const workspace = makeRoot();
    mkdirSync(join(workspace, ".git"));
    const configPath = join(workspace, ".zcode", "config.json");
    writeJson(configPath, {
      hooks: {
        enabled: true,
        events: {
          SessionStart: [{ hooks: [{ type: "command", command: "echo hello" }] }],
        },
      },
    });

    const { sources } = await readWorkspaceHookProjectSources({
      workingDirectory: workspace,
      explicitProjectConfigPath: configPath,
    });

    // 去重后只应有一个 source（auto-discovered），explicit 重复被丢弃
    expect(sources).toHaveLength(1);
    expect(sources[0]?.explicitProjectConfig).toBe(false);
    expect(sources[0]?.discoveryOrder).toBe(0);
  });
});
