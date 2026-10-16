import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHooksService } from "../src/hooks/hooksService.js";
import {
  parseWorkspaceHookTrustStoreContent,
  type WorkspaceHookTrustStoreParseResult,
} from "@zcode/shared/workspace-hook-trust-store-file";

/**
 * Trust store schema parity（CR-01 回归）。
 *
 * Bug 背景：services 层曾用手写的局部字段校验读 trust store，而 runtime/adapters
 * 用 contracts 的完整 strict schema。同一份"JSON 合法但结构非法"的文件，services
 * 会把其中形似合法的 digest 当作 trusted_persistent 展示，runtime 却 fail-closed
 * 全部阻断——UI 与执行层状态分裂。信任存储是权限边界，所有消费者必须对同一
 * 文件得出同一结论。
 *
 * 本测试以 shared 的 parseWorkspaceHookTrustStoreContent（与 adapters 使用的
 * contracts schema 同源 re-export）作为 runtime 侧判定基准，对一组损坏样本
 * 断言：runtime 判 invalid ⇔ services 必须 corrupt 且不产出任何 trusted 展示；
 * runtime 判 ok ⇔ services 采纳其中匹配的 digest。
 */

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "zcode-hook-trust-parity-"));
  roots.push(root);
  return root;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function setupWorkspaceWithHook(): { home: string; workspace: string } {
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
  return { home, workspace };
}

function trustStorePath(home: string): string {
  return join(home, ".zcode", "security", "workspace-hook-trust-v1.json");
}

const VALID_DIGEST = "a".repeat(64);

function runtimeVerdict(content: string): WorkspaceHookTrustStoreParseResult {
  return parseWorkspaceHookTrustStoreContent(content);
}

/** CR-01 原始症状样本：JSON 合法、digest 形似合法，但结构不符合 schema。 */
const STRUCTURALLY_INVALID_SAMPLES: Array<{ name: string; file: unknown }> = [
  {
    name: "缺少 schemaVersion",
    file: { records: [{ workspaceIdentity: "PLACEHOLDER", hookDeclarationDigest: VALID_DIGEST }] },
  },
  {
    name: "record 缺少 decision/grantedAt/digestAlgorithm 等必需字段",
    file: {
      schemaVersion: 1,
      records: [{ workspaceIdentity: "PLACEHOLDER", hookDeclarationDigest: VALID_DIGEST }],
    },
  },
  {
    name: "非法 decision",
    file: {
      schemaVersion: 1,
      records: [
        {
          workspaceIdentity: "PLACEHOLDER",
          hookDeclarationDigest: VALID_DIGEST,
          digestAlgorithm: "sha256",
          decision: "allow_once",
          grantedAt: "2026-08-17T09:00:00.000Z",
          eventAtGrant: "SessionStart",
          displayCommandAtGrant: "node recorder.mjs",
          sourcePathAtGrant: ".zcode/config.json",
        },
      ],
    },
  },
  {
    name: "非法时间戳",
    file: {
      schemaVersion: 1,
      records: [
        {
          workspaceIdentity: "PLACEHOLDER",
          hookDeclarationDigest: VALID_DIGEST,
          digestAlgorithm: "sha256",
          decision: "trusted",
          grantedAt: "not-a-timestamp",
          eventAtGrant: "SessionStart",
          displayCommandAtGrant: "node recorder.mjs",
          sourcePathAtGrant: ".zcode/config.json",
        },
      ],
    },
  },
  {
    name: "records 非数组",
    file: { schemaVersion: 1, records: { workspaceIdentity: "PLACEHOLDER" } },
  },
  {
    name: "未知顶层字段",
    file: {
      schemaVersion: 1,
      records: [],
      extra: { workspaceIdentity: "PLACEHOLDER", hookDeclarationDigest: VALID_DIGEST },
    },
  },
  {
    name: "未知 record 字段",
    file: {
      schemaVersion: 1,
      records: [
        {
          workspaceIdentity: "PLACEHOLDER",
          hookDeclarationDigest: VALID_DIGEST,
          digestAlgorithm: "sha256",
          decision: "trusted",
          grantedAt: "2026-08-17T09:00:00.000Z",
          eventAtGrant: "SessionStart",
          displayCommandAtGrant: "node recorder.mjs",
          sourcePathAtGrant: ".zcode/config.json",
          injected: true,
        },
      ],
    },
  },
];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("trust store schema parity：services 与 runtime 对同一文件必须同判（CR-01）", () => {
  for (const sample of STRUCTURALLY_INVALID_SAMPLES) {
    it(`结构非法样本（${sample.name}）：runtime 判 invalid ⇔ services 必须 corrupt 且不展示 trusted`, async () => {
      const { home, workspace } = setupWorkspaceWithHook();

      // 先拿到该 workspace 声明的真实 digest，替换样本占位符，确保"digest 本应匹配"。
      const first = await createHooksService().loadHooks({ workspacePath: workspace });
      const digest = first.workspaceHookSnapshot?.hooks[0]?.hookDeclarationDigest;
      expect(digest).toBeTruthy();
      // Bugfix 原因：直接把 workspace 路径 replaceAll 进 JSON 字符串，在 Windows 上
      // 会注入未转义的反斜杠，产生非法 JSON（Bad escaped character），样本构造直接崩。
      // 改为连引号一起替换成 JSON.stringify 的产物，保持任意平台的路径转义合法。
      const serialized = JSON.stringify(sample.file).replaceAll(
        '"PLACEHOLDER"',
        JSON.stringify(workspace),
      );

      // 基准：runtime 侧（shared schema，与 adapters 同源）判 invalid。
      expect(runtimeVerdict(serialized).status).toBe("invalid");

      writeJson(trustStorePath(home), JSON.parse(serialized));
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const loaded = await createHooksService().loadHooks({ workspacePath: workspace });

      // services 必须 fail-closed：不展示 trusted、标记 corrupt、发出诊断。
      expect(loaded.hooks[0]?.workspaceHook?.trustState).toBe("pending_trust");
      expect(loaded.trustStoreCorrupt).toBe(true);
      expect(warnSpy).toHaveBeenCalled();
    });
  }

  it("合法完整记录：runtime 判 ok ⇔ services 采纳匹配 digest 展示 trusted_persistent", async () => {
    const { home, workspace } = setupWorkspaceWithHook();
    const first = await createHooksService().loadHooks({ workspacePath: workspace });
    const digest = first.workspaceHookSnapshot?.hooks[0]?.hookDeclarationDigest;
    expect(digest).toBeTruthy();

    const file = {
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
    };
    const serialized = JSON.stringify(file);
    expect(runtimeVerdict(serialized).status).toBe("ok");

    writeJson(trustStorePath(home), file);
    const loaded = await createHooksService().loadHooks({ workspacePath: workspace });
    expect(loaded.hooks[0]?.workspaceHook?.trustState).toBe("trusted_persistent");
    expect(loaded.trustStoreCorrupt).toBeUndefined();
  });

  it("合法文件但记录属于其他 workspace：services 只采纳本 workspace 的 digest", async () => {
    const { home, workspace } = setupWorkspaceWithHook();
    const first = await createHooksService().loadHooks({ workspacePath: workspace });
    const digest = first.workspaceHookSnapshot?.hooks[0]?.hookDeclarationDigest;

    const file = {
      schemaVersion: 1,
      records: [
        {
          workspaceIdentity: "/another/workspace",
          hookDeclarationDigest: digest,
          digestAlgorithm: "sha256",
          decision: "trusted",
          grantedAt: "2026-08-17T09:00:00.000Z",
          eventAtGrant: "SessionStart",
          displayCommandAtGrant: "echo hello",
          sourcePathAtGrant: ".zcode/config.json",
        },
      ],
    };
    const serialized = JSON.stringify(file);
    expect(runtimeVerdict(serialized).status).toBe("ok");

    writeJson(trustStorePath(home), file);
    const loaded = await createHooksService().loadHooks({ workspacePath: workspace });
    expect(loaded.hooks[0]?.workspaceHook?.trustState).toBe("pending_trust");
    expect(loaded.trustStoreCorrupt).toBeUndefined();
  });
});
