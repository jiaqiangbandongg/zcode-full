import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHooksService } from "../src/hooks/hooksService.js";

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "zcode-hook-trust-corrupt-"));
  roots.push(root);
  return root;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(
    path,
    typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`,
    "utf8",
  );
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("readPersistentWorkspaceHookTrustDigests corrupt 检测（#7）", () => {
  it("trust store 文件不存在时返回空集且不发警告、不标记 corrupt", async () => {
    const home = makeRoot();
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
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const loaded = await createHooksService().loadHooks({
      workspacePath: workspace,
    });

    // 文件不存在 ⇒ 合理无记录，hook 标为 pending_trust（未持久信任），但非 corrupt。
    expect(loaded.hooks[0]?.workspaceHook?.trustState).toBe("pending_trust");
    expect(loaded.trustStoreCorrupt).toBeUndefined();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("trust store JSON 畸形时发警告、标记 corrupt、fail-closed 不返回 digest", async () => {
    const home = makeRoot();
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

    // 先加载一次拿到 declaration digest，再写入畸形 trust store。
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);

    const first = await createHooksService().loadHooks({
      workspacePath: workspace,
    });
    const digest = first.workspaceHookSnapshot?.hooks[0]?.hookDeclarationDigest;
    expect(digest).toBeTruthy();

    // 写入合法完整的 trust 记录以证明：若 trust store 畸形，即使存在有效记录也不会被采纳。
    // CR-01 后 services 使用与 runtime 相同的完整 strict schema——记录必须包含全部
    // 必需字段（旧测试只写 identity+digest，恰好依赖了被修复的局部校验 bug）。
    writeJson(join(home, ".zcode", "security", "workspace-hook-trust-v1.json"), {
      schemaVersion: 1,
      records: [
        {
          workspaceIdentity: workspace,
          hookDeclarationDigest: digest,
          digestAlgorithm: "sha256",
          decision: "trusted",
          grantedAt: "2026-08-17T09:00:00.000Z",
          eventAtGrant: "SessionStart",
          displayCommandAtGrant: "echo hello",
          sourcePathAtGrant: ".zcode/config.json",
        },
      ],
    });

    // 验证正常情况下会被信任。
    const trusted = await createHooksService().loadHooks({
      workspacePath: workspace,
    });
    expect(trusted.hooks[0]?.workspaceHook?.trustState).toBe("trusted_persistent");

    // 覆盖为畸形 JSON。
    writeJson(
      join(home, ".zcode", "security", "workspace-hook-trust-v1.json"),
      "{ this is :: not valid JSON !!!",
    );

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const loaded = await createHooksService().loadHooks({
      workspacePath: workspace,
    });

    // fail-closed：即使记录本应匹配，损坏文件不返回任何 digest，hook 回退 pending_trust。
    expect(loaded.hooks[0]?.workspaceHook?.trustState).toBe("pending_trust");
    expect(loaded.trustStoreCorrupt).toBe(true);
    expect(warnSpy).toHaveBeenCalled();
    // 统一 ServiceLogger 会把 scope、消息和结构化路径分成三个参数。
    // CR-01 后非法 JSON 统一走 schema 解析分支，文案为"结构不符合 schema"
    // （与 runtime/adapters 对同类文件的 corrupt 判定对齐）。
    expect(warnSpy.mock.calls[0]).toEqual([
      expect.stringContaining("[hooks-service]"),
      expect.stringContaining("Workspace Hook Trust store 结构不符合 schema"),
      expect.objectContaining({ path: expect.stringContaining("workspace-hook-trust") }),
    ]);
  });

  it("trust store 根节点非对象时同样标记 corrupt 并 fail-closed", async () => {
    const home = makeRoot();
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
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);

    // 根节点为数组（非对象）。
    writeJson(join(home, ".zcode", "security", "workspace-hook-trust-v1.json"), []);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const loaded = await createHooksService().loadHooks({
      workspacePath: workspace,
    });

    expect(loaded.hooks[0]?.workspaceHook?.trustState).toBe("pending_trust");
    expect(loaded.trustStoreCorrupt).toBe(true);
    expect(warnSpy).toHaveBeenCalled();
  });
});
