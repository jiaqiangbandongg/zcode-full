import type { IHooksService } from "@zcode/services";
import type { Hook } from "@zcode/shared";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { HookForm } from "@/settings/HookForm.js";
import { HooksList, groupHookSections } from "@/settings/HooksList.js";
import {
  buildPluginHookRows,
  filterPluginHooksByScope,
  isReadOnlyZCodeHook,
  resolveLatestReviewScopeTarget,
} from "@/settings/HooksSection.js";
import { useHooksStore } from "@/store/hooksStore.js";

afterEach(() => {
  useHooksStore.setState({
    workspacePath: null,
    workspaceIdentity: null,
    loadedWorkspaceKey: null,
    hooks: [],
    loading: false,
    error: null,
    operatingHookId: null,
  });
});

describe("Hooks settings page", () => {
  it("keeps same-name plugin hooks in separate marketplace groups", () => {
    const sections = groupHookSections(
      [],
      [],
      [
        {
          pluginId: "computer-use@zcode-plugins-official",
          pluginName: "computer-use",
          detail: { event: "PreToolUse", type: "command", command: "official" },
          pluginEnabled: true,
        },
        {
          pluginId: "zcode-cua@custom-marketplace",
          pluginName: "zcode-cua",
          detail: { event: "PreToolUse", type: "command", command: "custom" },
          pluginEnabled: true,
        },
      ],
    );

    expect(sections.filter((section) => section.kind === "plugin")).toHaveLength(2);
    expect(
      sections
        .filter((section) => section.kind === "plugin")
        .flatMap((section) => section.hooks.map((hook) => hook.pluginId)),
    ).toEqual([
      "computer-use@zcode-plugins-official",
      "zcode-cua@custom-marketplace",
    ]);
  });

  it("only exposes connected Workspaces to Hooks scope routing", () => {
    const source = readFileSync(
      new URL("../src/settings/HooksSection.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain("isPluginScopeWorkspaceConnected");
    expect(source).toContain(".filter(isPluginScopeWorkspaceConnected)");
  });

  it("does not classify plugin hooks as user when overview scope is unavailable", () => {
    const pluginRows = buildPluginHookRows(
      [
        {
          id: "quality@official",
          name: "quality",
          enabled: true,
          hookDetails: [
            {
              event: "PreToolUse",
              type: "command",
              command: "./check.sh",
              sourcePath: "/plugins/quality/hooks/hooks.json",
              runnable: true,
            },
          ],
        },
      ],
      [],
      false,
    );

    expect(pluginRows).toHaveLength(1);
    expect(pluginRows[0]?.pluginScope).toBeUndefined();
    expect(filterPluginHooksByScope(pluginRows, "user")).toEqual(pluginRows);
    expect(filterPluginHooksByScope(pluginRows, "project")).toEqual(pluginRows);

    const workspaceRows = buildPluginHookRows(
      [
        {
          id: "quality@official",
          name: "quality",
          enabled: true,
          hookDetails: pluginRows.map((row) => row.detail),
        },
      ],
      [{ id: "quality@official", scope: "workspace" }],
      true,
    );
    expect(filterPluginHooksByScope(workspaceRows, "user")).toEqual([]);
    expect(filterPluginHooksByScope(workspaceRows, "project")).toEqual(workspaceRows);
  });

  it("persists per-hook enabled state through saveHooks with workspace identity", async () => {
    const saved: Array<Parameters<IHooksService["saveHooks"]>[0]> = [];
    let persistedHooks = [configuredHook()];
    const service: IHooksService = {
      async loadHooks() {
        return {
          hooks: persistedHooks,
          hooksEnabled: persistedHooks.some((hook) => hook.enabled),
        };
      },
      async saveHooks(params) {
        saved.push(params);
        persistedHooks = params.hooks;
      },
    };
    useHooksStore.setState({
      workspacePath: "/workspace",
      workspaceIdentity: "ssh://dev/workspace",
      hooks: persistedHooks,
    });

    await useHooksStore.getState().toggleHook("configured", false, service);

    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      workspacePath: "/workspace",
      workspaceIdentity: "ssh://dev/workspace",
    });
    expect(saved[0]?.hooks[0]).toMatchObject({
      id: "configured",
      enabled: false,
    });
  });

  // Bugfix 回归：store 是单例，慢 workspace 的加载结果后到时曾无条件覆盖当前投影，
  // 之后任一写操作会把上一个 workspace 的整组 hooks 落盘到当前 workspace。
  it("discards a stale hooks load after the workspace scope changed", async () => {
    const hookA: Hook = { ...configuredHook(), id: "hook-a", command: "echo a" };
    const hookB: Hook = { ...configuredHook(), id: "hook-b", command: "echo b" };
    let releaseSlowLoad: (() => void) | undefined;
    const slowLoad = new Promise<void>((resolve) => {
      releaseSlowLoad = resolve;
    });
    const saved: Array<Parameters<IHooksService["saveHooks"]>[0]> = [];
    const service: IHooksService = {
      async loadHooks(params) {
        if (params.workspacePath === "/workspace-a") {
          await slowLoad;
          return { hooks: [hookA], hooksEnabled: true };
        }
        return { hooks: [hookB], hooksEnabled: true };
      },
      async saveHooks(params) {
        saved.push(params);
      },
    };

    const slowInitialize = useHooksStore
      .getState()
      .initialize("/workspace-a", undefined, service);
    await useHooksStore.getState().initialize("/workspace-b", undefined, service);
    releaseSlowLoad?.();
    await slowInitialize;

    expect(useHooksStore.getState().loadedWorkspaceKey).toBe("/workspace-b");
    expect(useHooksStore.getState().hooks.map((hook) => hook.id)).toEqual(["hook-b"]);

    await useHooksStore.getState().toggleHook("hook-b", false, service);

    expect(saved).toHaveLength(1);
    expect(saved[0]?.workspacePath).toBe("/workspace-b");
    expect(saved[0]?.hooks.map((hook) => hook.id)).toEqual(["hook-b"]);
  });

  it("imports a compatibility hook as an enabled ZCode hook", async () => {
    const legacy: Hook = {
      id: "legacy",
      event: "Stop",
      type: "command",
      command: "echo legacy",
      enabled: false,
      location: {
        source: "claude",
        scope: "project",
        directoryPath: "/workspace/.claude",
        projectPath: "/workspace",
      },
    };
    let persistedHooks = [legacy];
    const service: IHooksService = {
      async loadHooks() {
        return {
          hooks: persistedHooks,
          hooksEnabled: persistedHooks.some((hook) => hook.enabled),
        };
      },
      async saveHooks(params) {
        persistedHooks = params.hooks;
      },
    };
    useHooksStore.setState({
      workspacePath: "/workspace",
      hooks: persistedHooks,
    });

    await useHooksStore.getState().importHook("legacy", service);

    expect(persistedHooks).toContainEqual(
      expect.objectContaining({
        event: "Stop",
        command: "echo legacy",
        enabled: true,
        location: expect.objectContaining({
          source: "zcode",
          scope: "project",
        }),
      }),
    );
  });

  it("groups direct, plugin, and compatibility hooks by source", () => {
    const legacy: Hook = {
      id: "legacy",
      event: "Stop",
      type: "command",
      command: "echo legacy",
      enabled: false,
      location: {
        source: "claude",
        scope: "project",
        directoryPath: "/workspace/.claude",
      },
    };

    const sections = groupHookSections(
      [configuredHook(), { ...configuredHook(), id: "configured-2", event: "Stop" }],
      [legacy],
      [
        {
          pluginId: "quality@official",
          pluginName: "quality",
          pluginEnabled: true,
          pluginScope: undefined,
          detail: {
            event: "PostToolUse",
            matcher: "Write",
            type: "command",
            command: "./check.sh",
            sourcePath: "/plugins/quality/hooks/hooks.json",
            runnable: true,
          },
        },
      ],
    );
    expect(sections.map((section) => section.kind)).toEqual(["installed", "plugin", "legacy"]);
    expect(sections[1]).toMatchObject({ title: "quality", count: 1 });

    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(
          TooltipProvider,
          null,
          createElement(HooksList, {
            compatibilityHooks: [legacy],
            editableHooks: [configuredHook(), { ...configuredHook(), id: "configured-2", event: "Stop" }],
            operatingHookId: null,
            pluginHooks: [
              {
                pluginId: "quality@official",
                pluginName: "quality",
                pluginEnabled: true,
                pluginScope: undefined,
                pluginIconItem: { name: "quality", listing: undefined },
                detail: {
                  event: "PostToolUse",
                  matcher: "Write",
                  type: "command",
                  command: "./check.sh",
                  sourcePath: "/plugins/quality/hooks/hooks.json",
                  runnable: true,
                },
              },
            ],
            onDelete: async () => {},
            onEdit: () => {},
            onImport: async () => {},
            onToggle: async () => {},
            installedAction: createElement("button", null, "New"),
            showInstalledSection: true,
          }),
        ),
      ),
    );

    expect(html).toContain("PreToolUse");
    expect(html).toContain("Stop");
    expect(html).toContain("Installed");
    expect(html).toContain("New");
    expect(html).toContain(
      "flex flex-wrap items-center justify-between gap-3",
    );
    expect(html).not.toContain("flex h-7 items-center justify-between");
    expect(html).toContain("Legacy");
    expect(html).toContain("PostToolUse");
    expect(html).toContain("quality");
    expect(html).toContain("Scope unknown");
    expect(html).toContain("plugin-hook-row");
    expect(html).toContain("lucide-anchor");
    expect(html).not.toContain("lucide-webhook");
    expect(html).toContain("overflow-hidden rounded-xl bg-surface");
    expect(html).toContain("h-px bg-border/50");
    expect(html).toContain("font-mono text-ui-sm text-foreground-subtle");
    expect(html).toContain("hover:bg-hover");
    expect(html).not.toContain("Configured hooks");
    expect(html).not.toContain("Plugin hooks");
  });

  it("omits empty groups after filtering", () => {
    expect(groupHookSections([], [], [])).toEqual([]);
  });

  it("localizes built-in hook group titles", () => {
    const legacy: Hook = {
      id: "legacy-zh",
      event: "Stop",
      type: "command",
      command: "echo legacy",
      enabled: false,
      location: {
        source: "claude",
        scope: "user",
        directoryPath: "/home/.claude",
      },
    };
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(
          TooltipProvider,
          null,
          createElement(HooksList, {
            compatibilityHooks: [legacy],
            editableHooks: [configuredHook()],
            operatingHookId: null,
            pluginHooks: [],
            onEdit: () => {},
            onImport: async () => {},
            onToggle: async () => {},
          }),
        ),
      ),
    );

    expect(html).toContain("已安装");
    expect(html).toContain("旧版");
    expect(html).not.toContain(">Installed<");
    expect(html).not.toContain(">Legacy<");
  });

  it("renders an existing status message as an editable typed field", () => {
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(HookForm, {
          hook: {
            ...configuredHook(),
            type: "command",
            command: "echo verify",
            statusMessage: "Preparing workspace",
          },
          workspaceAvailable: true,
          onSave: () => {},
          onCancel: () => {},
          isEditing: true,
        }),
      ),
    );

    expect(html).toContain("Status message");
    expect(html).toContain('value="Preparing workspace"');
    expect(html).toContain('data-variant="ghost" data-size="lg"');
    expect(html).toContain("Manage task lifecycle hooks");
    expect(html).toContain("space-y-3 rounded-xl border border-border p-4");
    expect(html).not.toContain("rounded-xl border border-border bg-card p-4");
    expect(html).toContain('data-size="lg"');
    expect(html).toContain("flex flex-col gap-2 pt-1 sm:flex-row sm:items-center");
    expect(html).toContain("sm:ml-auto");
    expect(html).toContain("flex flex-wrap items-start justify-between gap-3");
    expect(html).toContain("items-center justify-end gap-2");
    expect(html).toContain('data-plugin-scope-trigger="true"');
    expect(html).toContain("sm:grid-cols-2");
    expect(html).toContain('id="hook-runner"');
    expect(html).not.toContain('aria-pressed="true"');
    expect(html).toContain("<details");
    expect(html).toContain("Advanced");
    expect(html).toContain("group-open/advanced:rotate-90");
  });

  // workspace-hook-trust：未信任的工作区 Hook 在任何 review 状态下都显示行内 Trust 按钮；
  // 信任状态不通过徽章展示，避免与运行时权威投影产生第二事实来源。
  it("无需活跃 review 也给未信任 Workspace Hook 显示行内信任按钮，并删除推导状态徽章", () => {
    const untrusted = {
      ...workspaceConfiguredHook("pending_trust"),
      id: "untrusted-disabled-row",
      enabled: false,
      workspaceHook: {
        ...workspaceConfiguredHook("pending_trust").workspaceHook!,
        configuredEnabled: false,
        reviewItemId: "untrusted-review-item",
      },
    };
    const trusted = {
      ...workspaceConfiguredHook("trusted_persistent"),
      id: "trusted-hook",
      workspaceHook: {
        ...workspaceConfiguredHook("trusted_persistent").workspaceHook!,
        reviewItemId: "trusted-hook",
      },
    };

    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(
          TooltipProvider,
          null,
          createElement(HooksList, {
            compatibilityHooks: [],
            editableHooks: [untrusted, trusted],
            operatingHookId: null,
            pluginHooks: [],
            trustActionAvailable: true,
            trustingHookId: null,
            onEdit: () => {},
            onImport: async () => {},
            onToggle: async () => {},
            onTrust: async () => {},
          }),
        ),
      ),
    );

    expect(html.match(/>Trust</gu)).toHaveLength(1);
    expect(html.indexOf(">Trust<")).toBeLessThan(html.indexOf('role="switch"'));
    expect(html).not.toContain("Configured on");
    expect(html).not.toContain("Configured off");
    expect(html).not.toContain("Needs review");
    expect(html).not.toContain("Trusted");
    expect(html).not.toContain("Will run");
    expect(html).not.toContain("Will not run");
  });

  it("未信任 Hook 的有效运行开关固定关闭并锁定，且不修改传入配置状态", () => {
    const untrustedConfiguredOn = workspaceConfiguredHook("pending_trust");
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(
          TooltipProvider,
          null,
          createElement(HooksList, {
            compatibilityHooks: [],
            editableHooks: [untrustedConfiguredOn],
            operatingHookId: null,
            pluginHooks: [],
            trustActionAvailable: false,
            trustingHookId: null,
            onEdit: () => {},
            onImport: async () => {},
            onToggle: async () => {},
            onTrust: async () => {},
          }),
        ),
      ),
    );

    expect(untrustedConfiguredOn.enabled).toBe(true);
    expect(html).toContain(">Trust<");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[^<]*<svg[^>]*lucide-shield-check/su);
    expect(html).toMatch(/role="switch"[^>]*aria-checked="false"[^>]*disabled=""/u);
  });

  it("持久信任后隐藏 Trust，并恢复配置开关的真实值与可操作性", () => {
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(
          TooltipProvider,
          null,
          createElement(HooksList, {
            compatibilityHooks: [],
            editableHooks: [workspaceConfiguredHook("trusted_persistent")],
            operatingHookId: null,
            pluginHooks: [],
            trustActionAvailable: true,
            trustingHookId: null,
            onEdit: () => {},
            onImport: async () => {},
            onToggle: async () => {},
            onTrust: async () => {},
          }),
        ),
      ),
    );

    expect(html).not.toContain(">Trust<");
    expect(html).toMatch(/role="switch"[^>]*aria-checked="true"/u);
    expect(html).not.toMatch(/role="switch"[^>]*disabled=""/u);
  });

  // P3 回归：editable=false 的上游/祖先 zcode.json Hook 是只读工作区 Hook，必须留在
  // Installed 分组走行内 Trust，而不是进 Legacy 显示必然失败的 Import。
  it("readonly zcode workspace hook stays in installed section with trust, not legacy import", () => {
    const readOnlyHook: Hook = {
      ...workspaceConfiguredHook("pending_trust"),
      editable: false,
      location: {
        source: "zcode",
        scope: "project",
        directoryPath: "/ancestor/.zcode",
        projectPath: "/workspace",
      },
    };
    expect(isReadOnlyZCodeHook(readOnlyHook)).toBe(true);
    expect(isReadOnlyZCodeHook(workspaceConfiguredHook("pending_trust"))).toBe(false);

    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(
          TooltipProvider,
          null,
          createElement(HooksList, {
            compatibilityHooks: [],
            editableHooks: [readOnlyHook],
            operatingHookId: null,
            pluginHooks: [],
            trustActionAvailable: true,
            trustingHookId: null,
            onEdit: () => {},
            onImport: async () => {},
            onToggle: async () => {},
            onTrust: async () => {},
          }),
        ),
      ),
    );

    expect(html).toContain("Installed");
    expect(html).not.toContain("Legacy");
    expect(html).toContain(">Trust<");
    expect(html).not.toContain(">Import<");
    // 只读行未信任：Switch 强制关闭并禁用（readOnly 且 requiresTrust 双重锁定）。
    expect(html).toMatch(/role="switch"[^>]*aria-checked="false"[^>]*disabled=""/u);
  });

  // P2 回归：refresh 发起时 target 已不是当前 workspace，必须整体放弃——
  // 不得 set({loading:true})，否则结果因 key 不匹配被丢弃后 loading 永远不复位。
  it("discards a stale refresh before it starts and never claims loading", async () => {
    let releaseLoad: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });
    let loadCalls = 0;
    const service: IHooksService = {
      async loadHooks() {
        loadCalls += 1;
        await gate;
        return { hooks: [], hooksEnabled: false };
      },
      async saveHooks() {},
    };
    // store 当前停在 workspace B；refresh 携带的却是 A 的三元组（Trust 等待期间切走）。
    useHooksStore.setState({ workspacePath: "/workspace-b", workspaceIdentity: null });
    const pending = useHooksStore.getState().refresh(service, { workspacePath: "/workspace-a" });
    // 同步段过后 loading 必须仍为 false：过期请求无权占用全局 loading。
    expect(useHooksStore.getState().loading).toBe(false);
    releaseLoad?.();
    await pending;
    expect(loadCalls).toBe(0);
    expect(useHooksStore.getState().loading).toBe(false);
  });

  // P2 回归：refresh 等待期间切走 → 结果丢弃，但 loading 归新 workspace 的
  // initialize 所有，丢弃路径不得把 loading 复位成影响新投影的状态。
  it("leaves loading ownership to the new workspace when refresh target drifts mid-flight", async () => {
    let releaseLoad: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });
    const service: IHooksService = {
      async loadHooks(params) {
        if (params.workspacePath === "/workspace-a") {
          await gate;
          return { hooks: [], hooksEnabled: false };
        }
        return { hooks: [configuredHook()], hooksEnabled: true };
      },
      async saveHooks() {},
    };
    useHooksStore.setState({ workspacePath: "/workspace-a", workspaceIdentity: null });
    const refreshA = useHooksStore.getState().refresh(service, { workspacePath: "/workspace-a" });
    // A 的 load 挂起期间切到 B 并完成 B 的 initialize（loading=true 属于 B 的加载）。
    const initB = useHooksStore.getState().initialize("/workspace-b", undefined, service);
    releaseLoad?.();
    await Promise.all([refreshA, initB]);
    // B 的投影完好，A 的过期结果没有污染；loading 最终由 B 的生命周期复位。
    expect(useHooksStore.getState().loadedWorkspaceKey).toBe("/workspace-b");
    expect(useHooksStore.getState().loading).toBe(false);
  });
});

describe("resolveLatestReviewScopeTarget", () => {
  const tabs = [
    { workspacePath: "/local/repo", workspaceIdentity: undefined },
    { workspacePath: "/remote/repo", workspaceIdentity: "ssh://dev/remote/repo" },
  ];

  it("maps the latest binding to a known workspace scope key by identity", () => {
    const target = resolveLatestReviewScopeTarget(
      {
        s1: {
          request: { interactionId: "i-1", createdAt: 1, workspaceIdentity: "ssh://dev/remote/repo" },
          workspacePath: "/remote/repo",
        },
      },
      tabs,
    );
    expect(target).toEqual({ interactionId: "i-1", scopeKey: "ssh://dev/remote/repo" });
  });

  it("falls back to workspacePath matching only for identity-less legacy bindings", () => {
    const target = resolveLatestReviewScopeTarget(
      {
        s1: {
          request: { interactionId: "i-2", createdAt: 2, workspaceIdentity: undefined },
          workspacePath: "/local/repo",
        },
      },
      tabs,
    );
    expect(target).toEqual({ interactionId: "i-2", scopeKey: "/local/repo" });
  });

  it("picks the newest interaction when multiple bindings exist", () => {
    const target = resolveLatestReviewScopeTarget(
      {
        s1: {
          request: { interactionId: "i-old", createdAt: 1, workspaceIdentity: "ssh://dev/remote/repo" },
          workspacePath: "/remote/repo",
        },
        s2: {
          request: { interactionId: "i-new", createdAt: 5, workspaceIdentity: undefined },
          workspacePath: "/local/repo",
        },
      },
      tabs,
    );
    expect(target).toEqual({ interactionId: "i-new", scopeKey: "/local/repo" });
  });

  // P2 回归：binding 指向已关闭/未知的 workspace 时返回 null——调用方不得
  // 把 scope 切过去（否则设置页会持续停在 Connecting，且与失效 scope 重置 user
  // 的 effect 形成乒乓循环）。
  it("returns null when the binding workspace no longer exists in tabs", () => {
    const target = resolveLatestReviewScopeTarget(
      {
        s1: {
          request: { interactionId: "i-gone", createdAt: 3, workspaceIdentity: "ssh://gone/repo" },
          workspacePath: "/gone/repo",
        },
      },
      tabs,
    );
    expect(target).toBeNull();
  });

  it("returns null when there are no bindings", () => {
    expect(resolveLatestReviewScopeTarget({}, tabs)).toBeNull();
  });
});

function configuredHook(): Hook {
  return {
    id: "configured",
    event: "PreToolUse",
    matcher: "Write",
    type: "process",
    command: "node",
    args: ["hook.mjs"],
    enabled: true,
    location: {
      source: "zcode",
      scope: "project",
      directoryPath: "/workspace/.zcode",
      projectPath: "/workspace",
    },
  };
}

function workspaceConfiguredHook(
  trustState: NonNullable<NonNullable<Hook["workspaceHook"]>["trustState"]>,
): Hook {
  return {
    ...configuredHook(),
    workspaceHook: {
      reviewItemId: "configured",
      workspaceIdentity: "local:/workspace",
      bundleDigest: "b".repeat(64),
      hookDeclarationDigest: "a".repeat(64),
      sourceFileIndex: 0,
      sourceRootEnabled: true,
      declarationEnabled: true,
      runtimeHooksEnabled: true,
      configuredEnabled: true,
      sourcePath: ".zcode/config.json",
      trustState,
    },
  };
}
