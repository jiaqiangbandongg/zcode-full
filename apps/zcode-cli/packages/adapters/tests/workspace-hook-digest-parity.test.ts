import { mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createConfig } from "../src/config/index.js";
import {
  buildWorkspaceHookBundleSnapshot,
  readWorkspaceHookProjectSources,
  resolveWorkspaceHookRuntimeRoot,
  workspaceHooksConfigSchema,
  type WorkspaceHooksConfig,
} from "@zcode/shared/workspace-hook-discovery";

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "zcode-hook-runtime-parity-"));
  roots.push(root);
  return root;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJsonIfDefined(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

/**
 * D17/M2 双 builder parity（Runtime 侧真实入口版）：
 * 本测试对比的是两个**真实**装配产物——
 *   actual：Runtime 的 createConfig（config-factory）产物 sources.project.workspaceHookSnapshot，
 *           层级含 DefaultRuntimeConfig.hooks / user config / project candidates / env / cli；
 *   reference：Settings（services/hooksService.loadHooks）的装配公式镜像，
 *           即 runtimeRoot = resolve([user.hooks, ...project hooks])、sources = project candidates
 *           （services 侧与 shared 都可直接调用同一批 API）。
 * 任何一侧的层级顺序、merge 语义、默认值变动使两道 snapshot 分叉（bundleDigest 或逐条
 * resolved 字段不一致），这里必须转红。此前 services 侧的 parity 测试两边都是 Settings
 * 逻辑的副本（Runtime 从未进入等式），改不了 Runtime 分叉；本测试补上 Runtime 真实侧。
 */
describe("workspace hook Settings/Runtime dual builder digest parity (D17 runtime entry)", () => {
  it("Runtime createConfig snapshot 与 Settings 装配公式产出一致 digest", async () => {
    const home = makeRoot();
    const workspace = makeRoot();
    await mkdir(join(workspace, ".git"));
    const userConfigPath = join(home, ".zcode", "cli", "config.json");
    await writeJson(userConfigPath, { hooks: { enabled: true, timeoutMs: 30_000 } });
    await writeJson(join(workspace, "zcode.json"), {
      hooks: {
        enabled: true,
        events: {
          Stop: [
            {
              matcher: ".*",
              hooks: [{ type: "command", command: "echo parity-root", async: true }],
            },
          ],
        },
      },
    });
    await writeJson(join(workspace, ".zcode", "config.json"), {
      hooks: {
        enabled: true,
        events: {
          SessionStart: [
            { hooks: [{ type: "process", command: "node", args: ["hook.mjs"], timeoutMs: 5_000 }] },
          ],
        },
      },
    });

    // ── 实测侧：Runtime 真实装配（Default层/user/project 全部进入 runtimeRoot）──
    const result = createConfig({
      env: {},
      projectConfigPath: undefined,
      skipUserConfig: false,
      userConfigPath,
      workingDirectory: workspace,
      workspaceIdentity: workspace,
    });
    const runtimeSnapshot = result.sources.project.workspaceHookSnapshot;
    expect(runtimeSnapshot).toBeDefined();

    // ── 参照侧：Settings 装配公式（hooksService.loadHooks 的等价 shared-API 序列）──
    const { sources: projectSources } = await readWorkspaceHookProjectSources({
      workingDirectory: workspace,
    });
    expect(projectSources.length).toBeGreaterThan(0);
    const userFile = (await readJsonIfDefined(userConfigPath)) as { hooks?: unknown } | undefined;
    const parsedUser = workspaceHooksConfigSchema.safeParse(userFile?.hooks);
    const userHooks: WorkspaceHooksConfig | undefined = parsedUser.success
      ? parsedUser.data
      : undefined;
    const settingsRoot = resolveWorkspaceHookRuntimeRoot([
      ...(userHooks ? [userHooks] : []),
      ...projectSources.map((source) => source.hooks),
    ]);
    const settingsSnapshot = buildWorkspaceHookBundleSnapshot({
      workspaceIdentity: workspace,
      workspacePath: workspace,
      sources: projectSources,
      runtimeRoot: settingsRoot,
    });
    expect(settingsSnapshot).toBeDefined();

    expect(runtimeSnapshot?.bundleDigest).toBe(settingsSnapshot?.bundleDigest);
    expect(runtimeSnapshot?.hooks.map((hook) => hook.hookDeclarationDigest)).toEqual(
      settingsSnapshot?.hooks.map((hook) => hook.hookDeclarationDigest),
    );
    expect(runtimeSnapshot?.hooks.map((hook) => hook.resolvedTimeoutMs)).toEqual(
      settingsSnapshot?.hooks.map((hook) => hook.resolvedTimeoutMs),
    );
    expect(runtimeSnapshot?.hooks.map((hook) => hook.configuredEnabled)).toEqual(
      settingsSnapshot?.hooks.map((hook) => hook.configuredEnabled),
    );
    // user hooks.enabled=true 必须传导为 runtimeHooksEnabled=true（否则两边都静默关闭）
    expect(runtimeSnapshot?.hooks.every((hook) => hook.runtimeHooksEnabled)).toBe(true);
  });

  it("导出快照实际使用的 runtimeRoot，供 toggle 重建复用同一取值", async () => {
    // 回归：审核请求由 config-factory 遍历 default/user/project/env/cli 全部层推导
    // runtimeRoot，而「审核中 toggle」曾在 create-app 内按单层 runtimeConfig.hooks
    // 另建一份。两者只要有一项不同就产生不同 bundleDigest，toggle 被误判为
    // snapshot_mismatch（2026-08-10 UAT 实测）。这里锁住导出值与快照的一致性，
    // 使复用成为结构性约束，而不是两处推导恰好相等的巧合。
    const workspace = makeRoot();
    await writeJson(join(workspace, ".zcode", "config.json"), {
      hooks: {
        enabled: true,
        // 刻意偏离默认值：单层重建会退回 60_000 / 32_768，从而暴露分叉。
        timeoutMs: 10_000,
        maxOutputBytes: 65_536,
        events: {
          SessionStart: [
            { matcher: "startup", hooks: [{ type: "command", command: "echo parity" }] },
          ],
        },
      } satisfies WorkspaceHooksConfig,
    });

    const config = await createConfig({ workingDirectory: workspace });
    const exported = config.sources.project.workspaceHookRuntimeRoot;
    expect(exported).toEqual({ enabled: true, timeoutMs: 10_000, maxOutputBytes: 65_536 });

    // 用导出的 runtimeRoot 重建，必须复现审核快照的 bundleDigest。
    const { sources } = await readWorkspaceHookProjectSources({ workingDirectory: workspace });
    const rebuilt = buildWorkspaceHookBundleSnapshot({
      workspaceIdentity: workspace,
      workspacePath: workspace,
      sources,
      runtimeRoot: exported!,
    });
    expect(rebuilt?.bundleDigest).toBe(config.sources.project.workspaceHookSnapshot?.bundleDigest);
  });

  it("explicit path 与 auto-discovery 指向同一文件时只生成一个 source", async () => {
    const workspace = makeRoot();
    await mkdir(join(workspace, ".git"));
    const configPath = join(workspace, "zcode.json");
    await writeJson(configPath, {
      hooks: {
        enabled: true,
        events: {
          SessionStart: [{ hooks: [{ type: "command", command: "echo deduplicated" }] }],
        },
      },
    });

    const runtime = createConfig({
      env: {},
      projectConfigPath: configPath,
      skipUserConfig: true,
      workingDirectory: workspace,
      workspaceIdentity: workspace,
    }).sources.project.workspaceHookSnapshot;
    const { sources } = await readWorkspaceHookProjectSources({
      workingDirectory: workspace,
      explicitProjectConfigPath: configPath,
    });
    const settings = buildWorkspaceHookBundleSnapshot({
      workspaceIdentity: workspace,
      workspacePath: workspace,
      sources,
      runtimeRoot: resolveWorkspaceHookRuntimeRoot(sources.map((source) => source.hooks)),
    });

    expect(runtime?.sourceFiles).toHaveLength(1);
    expect(runtime?.sourceFiles[0]).toMatchObject({
      canonicalPath: configPath,
      discoveryOrder: 0,
      explicitProjectConfig: false,
    });
    expect(runtime?.bundleDigest).toBe(settings?.bundleDigest);
  });

  it("损坏候选仍占 discoveryOrder，后续 source 的 Runtime/Settings digest 不错位", async () => {
    const workspace = makeRoot();
    await mkdir(join(workspace, ".git"));
    await writeFile(join(workspace, "zcode.json"), "{broken", "utf8");
    await writeJson(join(workspace, ".zcode", "config.json"), {
      hooks: {
        enabled: true,
        events: {
          Stop: [{ hooks: [{ type: "command", command: "echo valid-after-broken" }] }],
        },
      },
    });
    const explicitPath = join(workspace, "explicit-hooks.json");
    await writeJson(explicitPath, {
      hooks: {
        enabled: true,
        events: {
          UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo explicit" }] }],
        },
      },
    });

    const runtime = createConfig({
      env: {},
      projectConfigPath: explicitPath,
      skipUserConfig: true,
      workingDirectory: workspace,
      workspaceIdentity: workspace,
    }).sources.project.workspaceHookSnapshot;
    const { sources } = await readWorkspaceHookProjectSources({
      workingDirectory: workspace,
      explicitProjectConfigPath: explicitPath,
    });
    const settings = buildWorkspaceHookBundleSnapshot({
      workspaceIdentity: workspace,
      workspacePath: workspace,
      sources,
      runtimeRoot: resolveWorkspaceHookRuntimeRoot(sources.map((source) => source.hooks)),
    });

    expect(runtime?.sourceFiles.map((source) => source.discoveryOrder)).toEqual([1, 2]);
    expect(settings?.sourceFiles.map((source) => source.discoveryOrder)).toEqual([1, 2]);
    expect(runtime?.bundleDigest).toBe(settings?.bundleDigest);
  });
});
