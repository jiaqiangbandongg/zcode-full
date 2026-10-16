import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildWorkspaceHookBundleSnapshot,
  createWorkspaceHookSourceInput,
} from "../src/workspace-hook-discovery.js";
import {
  atomicWriteWorkspaceHookConfig,
  writeWorkspaceHookConfiguredToggle,
} from "../src/workspace-hook-mutation.js";

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "workspace-hook-mutation-"));
  roots.push(root);
  return root;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("workspace Hook atomic mutation", () => {
  it("只改变 snapshot 指向 declaration 的 enabled gate，并保留其他 config 与 passthrough 字段", async () => {
    const workspace = makeRoot();
    const configPath = join(workspace, ".zcode", "config.json");
    const original = {
      model: "model-test",
      customTopLevel: { keep: true },
      hooks: {
        enabled: true,
        timeoutMs: 1234,
        events: {
          SessionStart: [
            {
              hooks: [
                {
                  type: "command",
                  command: "echo first",
                  enabled: true,
                  customHookField: { keep: "yes" },
                },
                {
                  type: "process",
                  command: "node",
                  args: ["second.mjs"],
                  enabled: true,
                },
              ],
            },
          ],
        },
      },
    };
    writeJson(configPath, original);
    const source = createWorkspaceHookSourceInput({
      path: configPath,
      workingDirectory: workspace,
      hooks: original.hooks,
      discoveryOrder: 0,
      explicitProjectConfig: false,
    });
    const snapshot = buildWorkspaceHookBundleSnapshot({
      workspaceIdentity: "workspace:test",
      workspacePath: workspace,
      sources: [source],
      runtimeRoot: { enabled: true, timeoutMs: 60_000, maxOutputBytes: 32_768 },
    });

    await writeWorkspaceHookConfiguredToggle({
      configPath,
      snapshot,
      reviewItemId: snapshot.hooks[1]!.reviewItemId,
      enabled: false,
    });

    const saved = JSON.parse(readFileSync(configPath, "utf8"));
    expect(saved).toEqual({
      ...original,
      hooks: {
        ...original.hooks,
        events: {
          SessionStart: [
            {
              hooks: [
                original.hooks.events.SessionStart[0]!.hooks[0],
                {
                  ...original.hooks.events.SessionStart[0]!.hooks[1],
                  enabled: false,
                },
              ],
            },
          ],
        },
      },
    });
  });

  it("拒绝 snapshot 中非当前 .zcode/config.json 或非 editable declaration，且不写文件", async () => {
    const workspace = makeRoot();
    const configPath = join(workspace, ".zcode", "config.json");
    const ancestorPath = join(workspace, "zcode.json");
    const config = {
      hooks: {
        enabled: true,
        events: {
          Stop: [{ hooks: [{ type: "command" as const, command: "echo readonly" }] }],
        },
      },
    };
    writeJson(ancestorPath, config);
    writeJson(configPath, { hooks: { enabled: true, events: {} } });
    const source = createWorkspaceHookSourceInput({
      path: ancestorPath,
      workingDirectory: workspace,
      hooks: config.hooks,
      discoveryOrder: 0,
      explicitProjectConfig: false,
    });
    const snapshot = buildWorkspaceHookBundleSnapshot({
      workspaceIdentity: "workspace:test",
      workspacePath: workspace,
      sources: [source],
      runtimeRoot: { enabled: true, timeoutMs: 60_000, maxOutputBytes: 32_768 },
    });
    const before = readFileSync(configPath, "utf8");

    await expect(
      writeWorkspaceHookConfiguredToggle({
        configPath,
        snapshot,
        reviewItemId: snapshot.hooks[0]!.reviewItemId,
        enabled: false,
      }),
    ).rejects.toMatchObject({ code: "workspace_hooks_snapshot_mismatch" });
    expect(readFileSync(configPath, "utf8")).toBe(before);
  });

  it("磁盘 declaration 已变化时拒绝批准 A/修改 B", async () => {
    const workspace = makeRoot();
    const configPath = join(workspace, ".zcode", "config.json");
    const hooks = {
      enabled: true,
      events: {
        Stop: [{ hooks: [{ type: "command" as const, command: "echo before" }] }],
      },
    };
    writeJson(configPath, { hooks });
    const source = createWorkspaceHookSourceInput({
      path: configPath,
      workingDirectory: workspace,
      hooks,
      discoveryOrder: 0,
      explicitProjectConfig: false,
    });
    const snapshot = buildWorkspaceHookBundleSnapshot({
      workspaceIdentity: "workspace:test",
      workspacePath: workspace,
      sources: [source],
      runtimeRoot: { enabled: true, timeoutMs: 60_000, maxOutputBytes: 32_768 },
    });
    writeJson(configPath, {
      hooks: {
        ...hooks,
        events: {
          Stop: [{ hooks: [{ type: "command", command: "echo changed" }] }],
        },
      },
    });

    await expect(
      writeWorkspaceHookConfiguredToggle({
        configPath,
        snapshot,
        reviewItemId: snapshot.hooks[0]!.reviewItemId,
        enabled: false,
      }),
    ).rejects.toMatchObject({ code: "workspace_hooks_snapshot_mismatch" });
    expect(readFileSync(configPath, "utf8")).toContain("echo changed");
  });

  it("已知边界：root default 变化不触发 declaration mismatch（admission 侧仍按当前 snapshot 评估）", async () => {
    const workspace = makeRoot();
    const configPath = join(workspace, ".zcode", "config.json");
    const hooks = {
      enabled: true,
      timeoutMs: 5000,
      events: {
        Stop: [{ hooks: [{ type: "command" as const, command: "echo boundary" }] }],
      },
    };
    writeJson(configPath, { hooks });
    const source = createWorkspaceHookSourceInput({
      path: configPath,
      workingDirectory: workspace,
      hooks,
      discoveryOrder: 0,
      explicitProjectConfig: false,
    });
    const snapshot = buildWorkspaceHookBundleSnapshot({
      workspaceIdentity: "workspace:test",
      workspacePath: workspace,
      sources: [source],
      runtimeRoot: { enabled: true, timeoutMs: 5000, maxOutputBytes: 32_768 },
    });

    // 磁盘上仅修改 root 级 hooks.timeoutMs，不触碰 declaration 本体。
    writeJson(configPath, {
      hooks: { ...hooks, timeoutMs: 99_999 },
    });

    // 该守卫把 entry.resolvedTimeoutMs（review 时解析到的旧值）回填为 digest 的 default，
    // 因此重算 digest 必然与 entry.hookDeclarationDigest 相等——root default 变化不被捕获。
    // 这是有意的已知边界，此处 LOCK 以防回归时误改。
    await expect(
      writeWorkspaceHookConfiguredToggle({
        configPath,
        snapshot,
        reviewItemId: snapshot.hooks[0]!.reviewItemId,
        enabled: false,
      }),
    ).resolves.toBeUndefined();

    const saved = JSON.parse(readFileSync(configPath, "utf8"));
    expect(saved.hooks.timeoutMs).toBe(99_999);
    expect(saved.hooks.events.Stop[0]!.hooks[0]!.enabled).toBe(false);
  });

  it("rename 前失败保留原文件并清理 temp file", async () => {
    const workspace = makeRoot();
    const configPath = join(workspace, ".zcode", "config.json");
    writeJson(configPath, { hooks: { enabled: false, events: {} } });

    await expect(
      atomicWriteWorkspaceHookConfig(
        configPath,
        { hooks: { enabled: true, events: {} } },
        {
          beforeRename() {
            throw new Error("injected failure");
          },
        },
      ),
    ).rejects.toThrow("injected failure");

    expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({
      hooks: { enabled: false, events: {} },
    });
    await expect(readdir(join(workspace, ".zcode"))).resolves.toEqual(["config.json"]);
  });
});
