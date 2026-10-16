import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHooksService } from "../src/hooks/hooksService.js";
import { atomicWriteWorkspaceHookConfig } from "../src/hooks/workspaceHookConfigMutation.js";

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "zcode-hook-settings-phase1-"));
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
  vi.unstubAllEnvs();
});

describe("workspace hook Settings/Runtime discovery alignment", () => {
  it("无 task 的 Settings Trust 只向注入的 workspace authority 转发精确目标", async () => {
    const grantWorkspaceHookTrust = vi.fn(async () => ({ accepted: true }));
    const service = createHooksService({ grantWorkspaceHookTrust });
    const target = {
      workspacePath: "/repo",
      workspaceIdentity: "remote:ssh:host:/repo",
      bundleDigest: "b".repeat(64),
      hookDeclarationDigest: "a".repeat(64),
    };

    await expect(service.grantWorkspaceHookTrust?.(target)).resolves.toEqual({ accepted: true });
    expect(grantWorkspaceHookTrust).toHaveBeenCalledWith(target);
  });

  it("Settings 使用权威 snapshot，祖先/zcode.json 只读且 compatibility rows 不进入 snapshot", async () => {
    const home = makeRoot();
    const repo = join(makeRoot(), "repo");
    const workspace = join(repo, "packages", "app");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(workspace, { recursive: true });
    writeJson(join(repo, "zcode.json"), {
      hooks: {
        enabled: true,
        events: {
          Stop: [{ hooks: [{ type: "command", command: "echo zcode-json" }] }],
        },
      },
    });
    writeJson(join(workspace, ".zcode", "config.json"), {
      hooks: {
        enabled: true,
        events: {
          SessionStart: [
            {
              hooks: [{ type: "process", command: "node", args: ["hook.mjs"] }],
            },
          ],
        },
      },
    });
    writeJson(join(workspace, ".agents", "settings.json"), {
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "echo agents" }] }],
      },
    });
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);

    const loaded = await createHooksService().loadHooks({
      workspacePath: workspace,
      workspaceIdentity: "workspace:settings-test",
    });

    expect(loaded.workspaceHookSnapshot?.workspaceIdentity).toBe("workspace:settings-test");
    expect(loaded.workspaceHookSnapshot?.hooks).toHaveLength(2);
    expect(loaded.workspaceHookSnapshot?.sourceFiles.map((source) => source.editable)).toEqual([
      false,
      true,
    ]);

    const projectZCodeHooks = loaded.hooks.filter(
      (hook) => hook.location?.source === "zcode" && hook.location.scope === "project",
    );
    expect(projectZCodeHooks).toHaveLength(2);
    expect(projectZCodeHooks.map((hook) => hook.editable)).toEqual([false, true]);
    expect(projectZCodeHooks.every((hook) => Boolean(hook.workspaceHook))).toBe(true);

    const compatibility = loaded.hooks.find((hook) => hook.location?.source === "agents");
    expect(compatibility).toMatchObject({ enabled: false, editable: false });
    expect(compatibility?.workspaceHook).toBeUndefined();

    await createHooksService().saveHooks({
      workspacePath: workspace,
      hooks: loaded.hooks,
    });
    const savedCurrent = JSON.parse(readFileSync(join(workspace, ".zcode", "config.json"), "utf8"));
    expect(savedCurrent.hooks.events.SessionStart).toHaveLength(1);
    expect(savedCurrent.hooks.events.Stop).toBeUndefined();
    expect(readFileSync(join(repo, "zcode.json"), "utf8")).toContain("echo zcode-json");
  });

  it("Settings 只读 discovery 叠加 exact persistent Trust record", async () => {
    const home = makeRoot();
    const workspace = makeRoot();
    mkdirSync(join(workspace, ".git"));
    writeJson(join(home, ".zcode", "cli", "config.json"), {
      hooks: { enabled: true },
    });
    writeJson(join(workspace, ".zcode", "config.json"), {
      hooks: {
        enabled: true,
        events: {
          Stop: [{ hooks: [{ type: "command", command: "echo trust" }] }],
        },
      },
    });
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);

    const first = await createHooksService().loadHooks({
      workspacePath: workspace,
    });
    const digest = first.workspaceHookSnapshot?.hooks[0]?.hookDeclarationDigest;
    if (!digest) throw new Error("expected declaration digest");
    // 修复原因：CR-01 后 trust store 使用完整 strict schema（单源在 shared 的
    // workspace-hook-trust-store-file.ts），record 必须包含全部必填字段；旧用例只写
    // identity+digest 恰好依赖了被修复的局部校验 bug，会被 fail-closed 判为 invalid。
    writeJson(join(home, ".zcode", "security", "workspace-hook-trust-v1.json"), {
      schemaVersion: 1,
      records: [
        {
          workspaceIdentity: workspace,
          hookDeclarationDigest: digest,
          digestAlgorithm: "sha256",
          decision: "trusted",
          grantedAt: "2026-08-17T09:00:00.000Z",
          eventAtGrant: "Stop",
          displayCommandAtGrant: "echo trust",
          sourcePathAtGrant: ".zcode/config.json",
        },
      ],
    });

    const trusted = await createHooksService().loadHooks({
      workspacePath: workspace,
    });
    expect(trusted.hooks[0]?.workspaceHook?.trustState).toBe("trusted_persistent");
  });

  it("hooks.enabled 缺省暴露 source/runtime/configured 三层 gate，不由 hooksService 自行猜测", async () => {
    const home = makeRoot();
    const workspace = makeRoot();
    mkdirSync(join(workspace, ".git"));
    writeJson(join(workspace, ".zcode", "config.json"), {
      hooks: {
        events: {
          SessionStart: [{ hooks: [{ type: "command", command: "echo missing-enabled" }] }],
        },
      },
    });
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);

    const service = createHooksService();
    const disabled = await service.loadHooks({ workspacePath: workspace });
    expect(disabled.hooks[0]).toMatchObject({
      enabled: false,
      workspaceHook: {
        sourceRootEnabled: true,
        declarationEnabled: true,
        runtimeHooksEnabled: false,
        configuredEnabled: false,
      },
    });

    writeJson(join(home, ".zcode", "cli", "config.json"), {
      hooks: { enabled: true, events: {} },
    });
    const enabled = await service.loadHooks({ workspacePath: workspace });
    const projectHook = enabled.hooks.find((hook) => hook.location?.scope === "project");
    expect(projectHook).toMatchObject({
      enabled: true,
      workspaceHook: {
        sourceRootEnabled: true,
        declarationEnabled: true,
        runtimeHooksEnabled: true,
        configuredEnabled: true,
      },
    });
  });
});

describe("workspace hook config atomic mutation", () => {
  it("temp file flush/close 后 atomic rename 成功提交完整 JSON", async () => {
    const root = makeRoot();
    const path = join(root, ".zcode", "config.json");
    await atomicWriteWorkspaceHookConfig(path, {
      hooks: { enabled: true, events: {} },
    });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      hooks: { enabled: true, events: {} },
    });
  });

  it("rename 前失败时保留原文件且清理 temp file", async () => {
    const root = makeRoot();
    const path = join(root, ".zcode", "config.json");
    writeJson(path, { hooks: { enabled: false, events: {} } });

    await expect(
      atomicWriteWorkspaceHookConfig(
        path,
        { hooks: { enabled: true, events: {} } },
        {
          beforeRename() {
            throw new Error("injected failure");
          },
        },
      ),
    ).rejects.toThrow("injected failure");

    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      hooks: { enabled: false, events: {} },
    });
    const entries = (await import("node:fs/promises")).readdir(join(root, ".zcode"));
    await expect(entries).resolves.toEqual(["config.json"]);
  });
});
