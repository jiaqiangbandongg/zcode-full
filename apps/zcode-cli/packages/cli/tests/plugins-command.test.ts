import assert from "node:assert/strict";
import test from "node:test";
import type { RunContext } from "@zcode/shared-types";
import type { GlobalOptions } from "@zcode/shared-types";
import { runPluginsCommand } from "../src/plugins-command.js";
import { run } from "../src/run.js";

type CapturedWriteStream = NodeJS.WriteStream & { output(): string };

function stream(): CapturedWriteStream {
  let output = "";
  return {
    output: () => output,
    write(chunk: string | Uint8Array): boolean {
      output += typeof chunk === "string" ? chunk : chunk.toString();
      return true;
    },
  } as CapturedWriteStream;
}

function context(argv: string[]): RunContext & {
  stdout: CapturedWriteStream;
  stderr: CapturedWriteStream;
} {
  return {
    argv,
    stdin: { isTTY: false } as NodeJS.ReadStream,
    stdout: stream(),
    stderr: stream(),
  };
}

const TEXT: GlobalOptions = { force: false, json: false, noColor: false, verbose: false };
const JSON_OUT: GlobalOptions = { ...TEXT, json: true };

const loadedPlugin = (overrides: Record<string, unknown> = {}) =>
  ({
    commandRootCount: 1,
    dataPath: "/tmp/zcode/plugins/data/ios-dev@zcode-plugins-official",
    declaredMcpServerNames: [],
    enabled: true,
    hookDetails: [],
    id: "ios-dev@zcode-plugins-official",
    manifestPath: "/plugins/ios/.zcode-plugin/plugin.json",
    marketplace: "zcode-plugins-official",
    mcpServerNames: ["ios-simulator"],
    name: "ios-dev",
    rootPath: "/plugins/ios",
    skillCount: 1,
    skillRootCount: 1,
    source: "official",
    ...overrides,
  }) as never;

const listOutcome = (plugins: unknown[], diagnostics: unknown[] = []) =>
  (() => ({ commandRoots: [], diagnostics, mcpServers: {}, plugins, skillRoots: [] })) as never;

const installed = (overrides: Record<string, unknown> = {}) => ({
  enabled: true,
  id: "hello@market",
  marketplace: "market",
  name: "hello",
  scope: "user" as const,
  version: "1.2.0",
  ...overrides,
});

test("plugins list --json prints a plain array with per-plugin diagnostics", async () => {
  const ctx = context([]);
  const code = await runPluginsCommand(
    ctx,
    JSON_OUT,
    {
      cwd: () => "/work",
      listPlugins: listOutcome(
        [loadedPlugin()],
        [
          {
            code: "plugin_unsupported_component",
            message: "hooks ignored",
            pluginId: "ios-dev@zcode-plugins-official",
            severity: "warning",
          },
          { code: "plugin_manifest_invalid", message: "unrelated", severity: "warning" },
        ],
      ),
    },
    ["list"],
  );
  assert.equal(code, 0);
  const payload = JSON.parse(ctx.stdout.output()) as Array<Record<string, unknown>>;
  assert.equal(Array.isArray(payload), true);
  assert.equal(payload[0]?.id, "ios-dev@zcode-plugins-official");
  assert.deepEqual(payload[0]?.diagnostics, [
    {
      code: "plugin_unsupported_component",
      message: "hooks ignored",
      severity: "warning",
      pluginId: "ios-dev@zcode-plugins-official",
    },
  ]);
});

test("plugins list --json surfaces unattributable error diagnostics on stderr with exit 1", async () => {
  const failing = context([]);
  const code = await runPluginsCommand(
    failing,
    JSON_OUT,
    {
      listPlugins: listOutcome(
        [loadedPlugin()],
        [
          {
            code: "plugin_marketplace_refresh_failed",
            message: "git fetch failed",
            pluginId: "zcode-plugins-official",
            severity: "error",
          },
          { code: "plugin_manifest_invalid", message: "orphan", severity: "error" },
        ],
      ),
    },
    ["list"],
  );
  assert.equal(code, 1);
  const payload = JSON.parse(failing.stdout.output()) as Array<Record<string, unknown>>;
  assert.equal(Array.isArray(payload), true);
  assert.deepEqual(payload[0]?.diagnostics, []);
  assert.match(failing.stderr.output(), /zcode-plugins-official plugin_marketplace_refresh_failed: git fetch failed/);
  assert.match(failing.stderr.output(), /plugin_manifest_invalid: orphan/);

  const warning = context([]);
  assert.equal(
    await runPluginsCommand(
      warning,
      JSON_OUT,
      {
        listPlugins: listOutcome(
          [loadedPlugin()],
          [{ code: "plugin_marketplace_invalid", message: "stale", severity: "warning" }],
        ),
      },
      ["list"],
    ),
    0,
  );
  assert.equal(warning.stderr.output(), "");
});

test("plugins list --available merges the marketplace catalog", async () => {
  const ctx = context([]);
  const code = await runPluginsCommand(
    ctx,
    JSON_OUT,
    {
      cwd: () => "/work",
      listPlugins: listOutcome([loadedPlugin()]),
      getPluginsOverview: (() => ({
        marketplaces: [],
        availablePlugins: [
          {
            id: "hello@market",
            name: "hello",
            marketplace: "market",
            version: "1.2.0",
            installed: false,
            description: "Says hello",
          },
        ],
        installedPlugins: [],
        restorableBuiltins: [],
        diagnostics: [{ code: "plugin_marketplace_invalid", message: "stale", severity: "warning" }],
      })) as never,
    },
    ["list"],
    { available: true },
  );
  assert.equal(code, 0);
  const payload = JSON.parse(ctx.stdout.output()) as {
    installed: unknown[];
    available: Array<Record<string, unknown>>;
    diagnostics: unknown[];
  };
  assert.equal(payload.installed.length, 1);
  assert.equal(payload.available[0]?.id, "hello@market");
  assert.equal(payload.available[0]?.installed, false);
  assert.equal(payload.diagnostics.length, 1);
});

test("plugins install resolves a bare name across marketplaces and maps project scope", async () => {
  const ctx = context([]);
  let received: Record<string, unknown> | undefined;
  const code = await runPluginsCommand(
    ctx,
    TEXT,
    {
      cwd: () => "/work",
      getPluginsOverview: (() => ({
        marketplaces: [],
        availablePlugins: [
          { id: "hello@market", name: "hello", marketplace: "market", installed: false },
        ],
        installedPlugins: [],
        restorableBuiltins: [],
        diagnostics: [],
      })) as never,
      installPlugin: (async (options: Record<string, unknown>) => {
        received = options;
        return { dependencyClosure: ["hello@market"], installedPlugins: [installed()], diagnostics: [] };
      }) as never,
    },
    ["install", "hello"],
    { scope: "project" },
  );
  assert.equal(code, 0);
  assert.equal(received?.pluginName, "hello");
  assert.equal(received?.marketplace, "market");
  assert.equal(received?.scope, "workspace");
  assert.equal(received?.workingDirectory, "/work");
  assert.match(ctx.stdout.output(), /Installed plugin hello@market \(1\.2\.0\) \[enabled\]/);
});

test("plugins install rejects ambiguous bare names and unknown plugins", async () => {
  const overview = (() => ({
    marketplaces: [],
    availablePlugins: [
      { id: "hello@a", name: "hello", marketplace: "a", installed: false },
      { id: "hello@b", name: "hello", marketplace: "b", installed: false },
    ],
    installedPlugins: [],
    restorableBuiltins: [],
    diagnostics: [],
  })) as never;
  const ambiguous = context([]);
  assert.equal(
    await runPluginsCommand(ambiguous, TEXT, { getPluginsOverview: overview }, ["install", "hello"]),
    1,
  );
  assert.match(ambiguous.stderr.output(), /ambiguous.*hello@a, hello@b/);

  const missing = context([]);
  assert.equal(
    await runPluginsCommand(missing, TEXT, { getPluginsOverview: overview }, ["install", "nope"]),
    1,
  );
  assert.match(missing.stderr.output(), /Plugin not found in any marketplace: nope/);
});

test("plugins install surfaces error diagnostics with a non-zero exit", async () => {
  const ctx = context([]);
  const code = await runPluginsCommand(
    ctx,
    JSON_OUT,
    {
      installPlugin: (async () => ({
        dependencyClosure: [],
        installedPlugins: [],
        diagnostics: [
          {
            code: "plugin_not_found",
            message: "Plugin not found: nope@market",
            pluginId: "nope@market",
            severity: "error",
          },
        ],
      })) as never,
    },
    ["install", "nope@market"],
  );
  assert.equal(code, 1);
  const payload = JSON.parse(ctx.stdout.output()) as { ok: boolean; diagnostics: unknown[] };
  assert.equal(payload.ok, false);
  assert.equal(payload.diagnostics.length, 1);
});

test("plugins scope validation rejects local and unknown scopes", async () => {
  const local = context([]);
  assert.equal(
    await runPluginsCommand(local, TEXT, {}, ["install", "hello@market"], { scope: "local" }),
    1,
  );
  assert.match(local.stderr.output(), /Scope 'local' is not supported by zcode\. Use: user, project/);

  const bogus = context([]);
  assert.equal(await runPluginsCommand(bogus, TEXT, {}, ["enable", "hello"], { scope: "team" }), 1);
  assert.match(bogus.stderr.output(), /Invalid scope 'team'/);
});

test("plugins enable forwards the mapped scope", async () => {
  const ctx = context([]);
  let received: Record<string, unknown> | undefined;
  const code = await runPluginsCommand(
    ctx,
    TEXT,
    {
      setPluginEnabled: (async (options: Record<string, unknown>) => {
        received = options;
        return { enabled: true, path: "/repo/.zcode/config.json", plugin: loadedPlugin() };
      }) as never,
    },
    ["enable", "ios-dev"],
    { scope: "project" },
  );
  assert.equal(code, 0);
  assert.equal(received?.scope, "workspace");
  assert.match(ctx.stdout.output(), /Enabled plugin ios-dev@zcode-plugins-official/);
});

test("plugins disable --all disables every enabled plugin and rejects mixed usage", async () => {
  const disabled: string[] = [];
  const plugins = [
    loadedPlugin(),
    loadedPlugin({ id: "off@market", name: "off", enabled: false }),
    loadedPlugin({ id: "on@market", name: "on" }),
  ] as Array<{ id: string; enabled: boolean }>;
  const ctx = context([]);
  const code = await runPluginsCommand(
    ctx,
    TEXT,
    {
      // 有状态的 mock：写 user 层后复查 effective 态要能看到插件真的关掉了。
      listPlugins: (() => ({ commandRoots: [], diagnostics: [], mcpServers: {}, plugins, skillRoots: [] })) as never,
      setPluginEnabled: (async (options: { plugin: string; enabled: boolean }) => {
        disabled.push(options.plugin);
        assert.equal(options.enabled, false);
        const target = plugins.find((plugin) => plugin.id === options.plugin);
        if (target) target.enabled = false;
        return { enabled: false, path: "/home/u/.zcode/config.json", plugin: loadedPlugin({ id: options.plugin, enabled: false }) };
      }) as never,
    },
    ["disable"],
    { all: true },
  );
  assert.equal(code, 0);
  assert.deepEqual(disabled, ["ios-dev@zcode-plugins-official", "on@market"]);
  assert.equal(ctx.stderr.output(), "");

  const mixed = context([]);
  assert.equal(await runPluginsCommand(mixed, TEXT, {}, ["disable", "x"], { all: true }), 1);
  assert.match(mixed.stderr.output(), /Cannot use --all with a specific plugin/);

  const scoped = context([]);
  assert.equal(await runPluginsCommand(scoped, TEXT, {}, ["disable"], { all: true, scope: "user" }), 1);
  assert.match(scoped.stderr.output(), /Cannot use --scope with --all/);

  const none = context([]);
  assert.equal(await runPluginsCommand(none, TEXT, {}, ["disable"]), 1);
  assert.match(none.stderr.output(), /specify a plugin name or use --all/);
});

test("plugins disable --all reports plugins still enabled by a higher-priority config layer", async () => {
  // workspace 层 enabledPlugins[id]=true 盖过 user 层的 false：写入“成功”但 effective 态仍是启用。
  const plugins = [
    loadedPlugin(),
    loadedPlugin({ id: "pinned@market", name: "pinned" }),
    loadedPlugin({ id: "broken@market", name: "broken" }),
  ] as Array<{ id: string; enabled: boolean }>;
  const deps = {
    listPlugins: (() => ({ commandRoots: [], diagnostics: [], mcpServers: {}, plugins, skillRoots: [] })) as never,
    setPluginEnabled: (async (options: { plugin: string }) => {
      if (options.plugin === "broken@market") throw new Error("config write failed");
      const target = plugins.find((plugin) => plugin.id === options.plugin);
      if (target && options.plugin !== "pinned@market") target.enabled = false;
      return { enabled: false, path: "/home/u/.zcode/config.json", plugin: loadedPlugin({ id: options.plugin, enabled: false }) };
    }) as never,
  };

  const human = context([]);
  assert.equal(await runPluginsCommand(human, TEXT, deps, ["disable"], { all: true }), 1);
  assert.match(human.stdout.output(), /Disabled plugin ios-dev@zcode-plugins-official/);
  assert.doesNotMatch(human.stdout.output(), /Disabled plugin pinned@market/);
  assert.match(human.stderr.output(), /pinned@market is still enabled by a higher-priority config layer/);
  assert.match(human.stderr.output(), /Failed to disable plugin broken@market: config write failed/);

  for (const plugin of plugins) plugin.enabled = true;
  const json = context([]);
  assert.equal(await runPluginsCommand(json, JSON_OUT, deps, ["disable"], { all: true }), 1);
  const payload = JSON.parse(json.stdout.output()) as Array<{
    effectiveEnabled: boolean;
    error?: string;
    plugin: { id: string };
  }>;
  assert.deepEqual(
    payload.map((entry) => [entry.plugin.id, entry.effectiveEnabled, entry.error ?? null]),
    [
      ["ios-dev@zcode-plugins-official", false, null],
      ["pinned@market", true, null],
      ["broken@market", true, "config write failed"],
    ],
  );
});

test("plugins uninstall --keep-data forwards keepData and resolves bare names", async () => {
  const ctx = context([]);
  let received: Record<string, unknown> | undefined;
  const code = await runPluginsCommand(
    ctx,
    { ...JSON_OUT, force: true },
    {
      listPlugins: listOutcome([loadedPlugin()]),
      uninstallPlugin: (async (options: Record<string, unknown>) => {
        received = options;
        return installed({ id: "ios-dev@zcode-plugins-official", name: "ios-dev", marketplace: "zcode-plugins-official" });
      }) as never,
    },
    ["uninstall", "ios-dev"],
    { keepData: true },
  );
  assert.equal(code, 0);
  assert.equal(received?.pluginId, "ios-dev@zcode-plugins-official");
  assert.equal(received?.keepData, true);
  const payload = JSON.parse(ctx.stdout.output()) as { removed: boolean; keptData?: boolean };
  assert.equal(payload.removed, true);
  assert.equal(payload.keptData, true);
});

test("plugins update reports version transitions and up-to-date state", async () => {
  const changed = context([]);
  const code = await runPluginsCommand(
    changed,
    TEXT,
    {
      updatePlugin: (async () => ({
        dependencyClosure: ["hello@market"],
        installedPlugins: [installed({ version: "2.0.0" })],
        diagnostics: [],
        previousVersion: "1.2.0",
      })) as never,
    },
    ["update", "hello@market"],
  );
  assert.equal(code, 0);
  assert.match(changed.stdout.output(), /Updated plugin hello@market from 1\.2\.0 to 2\.0\.0\. Restart zcode to apply\./);

  const same = context([]);
  await runPluginsCommand(
    same,
    TEXT,
    {
      updatePlugin: (async () => ({
        dependencyClosure: ["hello@market"],
        installedPlugins: [installed()],
        diagnostics: [],
        previousVersion: "1.2.0",
      })) as never,
    },
    ["update", "hello@market"],
  );
  assert.match(same.stdout.output(), /already up to date \(1\.2\.0\)/);
});

test("plugins validate exits non-zero on error diagnostics", async () => {
  const bad = context([]);
  const code = await runPluginsCommand(
    bad,
    TEXT,
    {
      validatePluginPath: (async (options: { path: string }) => {
        assert.equal(options.path, "./plugin");
        return [{ code: "plugin_manifest_not_found", message: "missing", severity: "error" }];
      }) as never,
    },
    ["validate", "./plugin"],
  );
  assert.equal(code, 1);
  assert.match(bad.stderr.output(), /Plugin manifest is invalid: \.\/plugin/);
  assert.match(bad.stderr.output(), /plugin_manifest_not_found: missing/);

  const good = context([]);
  assert.equal(
    await runPluginsCommand(good, TEXT, { validatePluginPath: (async () => []) as never }, [
      "validate",
      "./plugin",
    ]),
    0,
  );
  assert.match(good.stdout.output(), /Plugin manifest is valid/);
});

test("plugins marketplace add/list/remove/update route to bootstrap", async () => {
  const calls: string[] = [];
  const deps = {
    addMarketplace: (async (options: { source: string; sparsePaths?: string[] }) => {
      calls.push(`add:${options.source}:${(options.sparsePaths ?? []).join("+")}`);
      return { id: "market", name: "market", source: { source: "git", url: "x" }, pluginCount: 3, isOfficial: false };
    }) as never,
    getPluginsOverview: (() => ({
      marketplaces: [
        { id: "market", name: "market", source: { source: "git", url: "https://x/y.git" }, pluginCount: 3, isOfficial: false },
      ],
      availablePlugins: [],
      installedPlugins: [],
      restorableBuiltins: [],
      diagnostics: [],
    })) as never,
    removeMarketplace: (async (options: { marketplace: string }) => {
      calls.push(`remove:${options.marketplace}`);
    }) as never,
    updateMarketplace: (async (options: { marketplace?: string }) => {
      calls.push(`update:${options.marketplace ?? "*"}`);
      return {
        marketplaces: [{ id: "market", name: "market", source: {}, pluginCount: 4, isOfficial: false }],
        diagnostics: [],
      };
    }) as never,
  };

  const add = context([]);
  assert.equal(
    await runPluginsCommand(add, TEXT, deps, ["marketplace", "add", "owner/repo"], { sparse: ["plugins"] }),
    0,
  );
  assert.match(add.stdout.output(), /Added marketplace market \(3 plugins\)/);

  const list = context([]);
  assert.equal(await runPluginsCommand(list, JSON_OUT, deps, ["marketplace", "list"]), 0);
  assert.equal((JSON.parse(list.stdout.output()) as unknown[]).length, 1);

  const remove = context([]);
  assert.equal(await runPluginsCommand(remove, TEXT, deps, ["marketplace", "remove", "market"]), 0);

  const updateOne = context([]);
  assert.equal(await runPluginsCommand(updateOne, TEXT, deps, ["marketplace", "update", "market"]), 0);
  assert.match(updateOne.stdout.output(), /Updated marketplace market \(4 plugins\)/);
  const updateAll = context([]);
  assert.equal(await runPluginsCommand(updateAll, TEXT, deps, ["marketplace", "update"]), 0);

  assert.deepEqual(calls, ["add:owner/repo:plugins", "remove:market", "update:market", "update:*"]);

  const unknown = context([]);
  assert.equal(await runPluginsCommand(unknown, TEXT, deps, ["marketplace", "frobnicate"]), 1);
  assert.match(unknown.stderr.output(), /Unknown marketplace command: frobnicate/);
});

test("run() accepts the plugin alias and collects plugin flags from argv", async () => {
  const ctx = context(["plugin", "disable", "--all", "-s", "user"]);
  const code = await run(ctx, {
    cwd: () => "/work",
    listPlugins: listOutcome([loadedPlugin()]),
  });
  assert.equal(code, 1);
  assert.match(ctx.stderr.output(), /Cannot use --scope with --all/);

  const install = context(["plugins", "install", "hello@market", "--scope", "project", "--json"]);
  let received: Record<string, unknown> | undefined;
  const installCode = await run(install, {
    cwd: () => "/work",
    installPlugin: (async (options: Record<string, unknown>) => {
      received = options;
      return { dependencyClosure: [], installedPlugins: [installed()], diagnostics: [] };
    }) as never,
  });
  assert.equal(installCode, 0);
  assert.equal(received?.scope, "workspace");
  assert.equal((JSON.parse(install.stdout.output()) as { ok: boolean }).ok, true);
});
