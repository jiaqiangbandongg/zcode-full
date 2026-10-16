import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type {
  CustomCommandRoot,
  HookConfig,
  HookEventName,
  HookMatcherConfig,
  HookPluginContext,
  PluginConfig,
  PluginDiagnostic,
  PluginDiscoverRequest,
  PluginHookDetail,
  PluginLoadOutcome,
  PluginManifest,
  PluginUiSurfaceDefinition,
  PluginMetadata,
  PluginOperationOptions,
  PluginPort,
  SkillRoot,
} from "@zcode/contracts";
import {
  HookEventName as HookEventNameValue,
  HookMatcherConfigSchema,
  ZCODE_INLINE_PLUGIN_MARKETPLACE,
  ZCODE_OFFICIAL_PLUGIN_MARKETPLACE,
} from "@zcode/contracts";
import {
  directoryExists,
  fileExists,
  isMissingPath,
  isNotFoundError,
  isRecord,
  parsePathList,
  resolveInside,
  sanitizePluginId,
  throwIfAborted,
} from "./helpers.js";
import { scanSkillFilesUnderRootSync } from "../skills/scan.js";
import { loadPluginMcpServerDefinitions, resolvePluginMcpServers } from "./mcp.js";
import { parsePluginUiSurfaces } from "./ui-surfaces.js";
import { listPluginHookSources } from "./hook-sources.js";
import { enumeratePluginComponents } from "./plugin-components.js";
import {
  listInstalledPluginRecords,
  normalizeAuthorValue,
  resolveInstalledPluginRoot,
} from "./marketplace.js";
import { loadBundledOfficialPluginRootsSync } from "./official-marketplace.js";
import type {
  LoadedPlugin,
  PluginAbortOptions,
  PluginCandidate,
  PluginComponents,
} from "./types.js";

export {
  addMarketplace,
  applyClaudePluginIcons,
  describeMarketplacePlugin,
  enrichCachedClaudeMarketplaceIcons,
  ensureDefaultPluginMarketplaces,
  ensureMarketplaceManifestAvailable,
  getPluginDataDir,
  installMarketplacePlugin,
  listInstalledPluginRecords,
  loadKnownMarketplacesSync,
  loadMarketplaceManifestSync,
  normalizeAuthorValue,
  parseEntryStoreListing,
  parsePluginIconSources,
  parseMarketplaceSourceInput,
  readPluginSourceIdentityPin,
  readPluginSourceSha,
  removeMarketplace,
  uninstallMarketplacePlugin,
  updateMarketplace,
  validateMarketplacePlugin,
  validateLocalPluginPath,
  validateMarketplaceSource,
  type DescribeMarketplacePluginResult,
  type InstalledPluginRecord,
  type KnownMarketplaceRecord,
  type MarketplaceSource,
  type PluginComponentGroup,
  type PluginComponentItem,
  type PluginComponentKind,
  type PluginManifestDisplayMetadata,
  type PluginMarketplaceEntry,
  type PluginMarketplaceManifest,
} from "./marketplace.js";

export {
  writeBundledOfficialMarketplacePartitionSync,
  writeCdnOfficialMarketplacePartitionSync,
} from "./official-marketplace.js";

export { getPluginSourceDiagnosticCode } from "./source-errors.js";

export {
  comparePluginUpdate,
  comparePluginVersions,
  type PluginUpdateStatus,
} from "./version-compare.js";

const ZCODE_MANIFEST_PATH = join(".zcode-plugin", "plugin.json");
const CLAUDE_MANIFEST_PATH = join(".claude-plugin", "plugin.json");
const CODEX_MANIFEST_PATH = join(".codex-plugin", "plugin.json");
const DEFAULT_VERSION = "0.0.0";
const FIRST_PLUGIN_PRIORITY = 1_000;
const PRIORITY_STEP = 10;
const PLUGIN_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const UNSUPPORTED_COMPONENT_KEYS = ["channels", "lspServers", "outputStyles", "settings"] as const;
const SUPPORTED_HOOK_EVENTS = new Set<string>(Object.values(HookEventNameValue));

interface PluginHookInspection {
  details: PluginHookDetail[];
  events: Partial<Record<HookEventName, HookMatcherConfig[]>>;
}

export interface NodePluginAdapterOptions {
  storageRoot: string;
}

export class NodePluginAdapter implements PluginPort {
  constructor(private readonly options: NodePluginAdapterOptions) {}

  async discoverPlugins(
    request: PluginDiscoverRequest,
    options?: PluginOperationOptions,
  ): Promise<PluginLoadOutcome> {
    return this.discoverPluginsSync(request, options);
  }

  discoverPluginsSync(
    request: PluginDiscoverRequest,
    options?: PluginAbortOptions,
  ): PluginLoadOutcome {
    if (!request.config.enabled) return emptyOutcome();

    const diagnostics: PluginDiagnostic[] = [];
    const dataRoot = join(request.storageRoot || this.options.storageRoot, "data");
    const candidates = this.resolveCandidates(request, diagnostics, options);
    const commandRoots: CustomCommandRoot[] = [];
    const hooks: PluginLoadOutcome["hooks"] = {};
    const mcpServers: PluginLoadOutcome["mcpServers"] = {};
    const plugins: PluginMetadata[] = [];
    const seen = new Set<string>();
    const skillRoots: SkillRoot[] = [];
    let priority = FIRST_PLUGIN_PRIORITY;

    for (const candidate of candidates) {
      throwIfAborted(options);
      const loaded = loadPlugin(candidate, diagnostics);
      if (!loaded) continue;
      // 内置（官方）插件被「卸载」后只在 user config 写 suppressedBuiltins 标记。这里在发现层
      // 用插件的权威 id（manifest 名 @ marketplace）过滤，不依赖缓存文件是否已被物理删除——
      // 这样即便 app 升级遗留了旧版本缓存目录、或会话内 facade 持有过时配置，被卸载的内置插件
      // 也不会被重新发现。仅作用于 official 源，inline/cache（市场安装）不受影响。
      if (loaded.source === "official" && request.config.suppressedBuiltins.includes(loaded.id)) {
        continue;
      }
      if (seen.has(loaded.id)) {
        diagnostics.push({
          code: "plugin_duplicate_id",
          message: `Duplicate plugin ignored: ${loaded.id}`,
          path: loaded.rootPath,
          pluginId: loaded.id,
          severity: "warning",
        });
        continue;
      }
      seen.add(loaded.id);
      warnUnsupportedComponents(loaded, diagnostics);

      // candidate.defaultEnabled 在 candidate 构造时无法访问 plugin id,
      // 这里再叠加 bootstrap 提供的 "默认开" 名单 (按 `<name>@<marketplace>` 匹配)。
      const candidateDefaultEnabled =
        candidate.defaultEnabled ||
        (request.officialPluginsEnabledByDefault?.has(loaded.id) ?? false);
      const enabled = resolveEnabled(request.config, loaded.id, candidateDefaultEnabled);
      const dataPath = join(dataRoot, sanitizePluginId(loaded.id));
      // 只从启用后解析出的 component.mcpServers 生成 mcpServerNames，
      // 未启用插件的内置 MCP 就会在管理页完全不可见。这里先读取声明名给 UI 只读展示，
      // 实际 runtime 注入仍只使用 enabled 分支解析出的 component.mcpServers。
      const mcpServerDefinitions = loadPluginMcpServerDefinitions({ diagnostics, loaded });
      const hooksRunnable = canRunPluginHooks(loaded);
      const hookInspection = inspectPluginHooks({
        dataPath,
        diagnostics,
        loaded,
        runnable: hooksRunnable,
      });
      const component = enabled
        ? resolveEnabledComponents({
            dataPath,
            diagnostics,
            env: request.env ?? {},
            hookEvents: hooksRunnable ? hookInspection.events : {},
            hookDetails: hookInspection.details,
            loaded,
            mcpServerDefinitions,
            options: request.config.options[loaded.id] ?? {},
            priority,
            workingDirectory: request.workingDirectory,
          })
        : emptyComponents(hookInspection.details);
      priority += PRIORITY_STEP;

      Object.assign(mcpServers, component.mcpServers);
      mergeHookEvents(hooks, component.hooks);
      skillRoots.push(...component.skillRoots);
      commandRoots.push(...component.commandRoots);
      const declaredMcpServerNames = Object.keys(mcpServerDefinitions);
      plugins.push(
        createPluginMetadata(
          loaded,
          component,
          dataPath,
          enabled,
          declaredMcpServerNames,
          request.config.options[loaded.id] ?? {},
          // 插件 UI 面板入口（A5）：与启用态无关地解析，禁用插件的入口由 listUiSurfaces 过滤。
          parsePluginUiSurfaces({ loaded, declaredMcpServerNames, diagnostics }),
        ),
      );
    }

    return {
      commandRoots,
      diagnostics,
      hooks,
      mcpServers,
      plugins,
      skillRoots,
    };
  }

  private resolveCandidates(
    request: Pick<PluginDiscoverRequest, "config" | "officialPluginRoots" | "storageRoot">,
    diagnostics: PluginDiagnostic[],
    options?: PluginAbortOptions,
  ): PluginCandidate[] {
    const candidates: PluginCandidate[] = [];
    for (const rootPath of request.config.dirs) {
      candidates.push({
        defaultEnabled: true,
        marketplace: ZCODE_INLINE_PLUGIN_MARKETPLACE,
        rootPath: resolve(rootPath),
        source: "inline",
      });
    }
    for (const rootPath of request.officialPluginRoots ?? []) {
      candidates.push({
        defaultEnabled: false,
        marketplace: ZCODE_OFFICIAL_PLUGIN_MARKETPLACE,
        rootPath: resolve(rootPath),
        source: "official",
      });
    }
    candidates.push(
      ...scanOfficialCache(request.storageRoot, diagnostics, options).map((rootPath) => ({
        defaultEnabled: false,
        marketplace: ZCODE_OFFICIAL_PLUGIN_MARKETPLACE,
        rootPath,
        source: "official" as const,
      })),
    );
    for (const installed of listInstalledPluginRecords(request.storageRoot)) {
      candidates.push({
        defaultEnabled: false,
        marketplace: installed.marketplace,
        rootPath: resolveInstalledPluginRoot(request.storageRoot, installed),
        source: "cache",
      });
    }
    return candidates;
  }
}

export function createNodePluginAdapter(options: NodePluginAdapterOptions): NodePluginAdapter {
  return new NodePluginAdapter(options);
}

export function discoverNodePluginsSync(
  request: PluginDiscoverRequest,
  options?: PluginAbortOptions,
): PluginLoadOutcome {
  return createNodePluginAdapter({ storageRoot: request.storageRoot }).discoverPluginsSync(
    request,
    options,
  );
}

function createPluginMetadata(
  loaded: LoadedPlugin,
  component: PluginComponents,
  dataPath: string,
  enabled: boolean,
  declaredMcpServerNames: string[],
  configuredOptions: Record<string, string | number | boolean>,
  uiSurfaces: PluginUiSurfaceDefinition[],
): PluginMetadata {
  // manifest 的 author/homepage 作为详情页信息区的回退来源（商店 listing 优先）。
  const author = normalizeAuthorValue(loaded.manifest.author);
  const homepage =
    typeof loaded.manifest.homepage === "string" && loaded.manifest.homepage.trim().length > 0
      ? loaded.manifest.homepage
      : undefined;
  return {
    ...(author?.name ? { author: author.name } : {}),
    ...(author?.url ? { authorUrl: author.url } : {}),
    ...(homepage ? { homepage } : {}),
    commandRootCount: component.commandRoots.length,
    // 详情 UI 过去靠 plugin.skillCount（权威计数）+ 一条 UI 侧 join（按 pluginName 过滤
    // skillsService 结果）拿名称，二者数据源分离。停用插件走 emptyComponents() 使 skillCount=0、
    // 且 UI join 对停用插件不产出名称（skillsService 里 `if (!enabled) continue`），导致：停用时
    // 整个技能分组消失、启用时只有数量没有名称。这里改为对插件根目录做权威枚举（与启用态无关），
    // 直接把名称+描述随 list 下发，UI 不再需要脆弱的 join。
    components: enumeratePluginComponents(loaded.rootPath, loaded.manifest, { loaded }),
    configuredOptions,
    dataPath,
    declaredMcpServerNames,
    description: loaded.manifest.description,
    enabled,
    id: loaded.id,
    manifestPath: loaded.manifestPath,
    marketplace: loaded.marketplace,
    mcpServerNames: Object.keys(component.mcpServers),
    name: loaded.manifest.name,
    hookDetails: component.hookDetails,
    rootPath: loaded.rootPath,
    skillCount: component.skillCount,
    skillRootCount: component.skillRoots.length,
    source: loaded.source,
    ...(uiSurfaces.length > 0 ? { uiSurfaces } : {}),
    userConfig: loaded.manifest.userConfig,
    version: loaded.manifest.version,
  };
}

function resolveEnabledComponents(input: {
  dataPath: string;
  diagnostics: PluginDiagnostic[];
  env: Record<string, string | undefined>;
  hookDetails: PluginHookDetail[];
  hookEvents: Partial<Record<HookEventName, HookMatcherConfig[]>>;
  loaded: LoadedPlugin;
  mcpServerDefinitions: Record<string, unknown>;
  options: Record<string, string | number | boolean>;
  priority: number;
  workingDirectory: string;
}): PluginComponents {
  mkdirSync(input.dataPath, { recursive: true });

  const skillRoots = resolveSkillRoots(input, input.priority);
  return {
    commandRoots: resolveCommandRoots(input, input.priority + 1),
    hooks: input.hookEvents,
    hookDetails: input.hookDetails,
    mcpServers: resolvePluginMcpServers({
      ...input,
      definitions: input.mcpServerDefinitions,
    }),
    // 插件页要展示真实技能数量。之前只统计 skills root 数，
    // document-skills 这种一个 root 下有多个 SKILL.md 的插件会被显示成 1。
    skillCount: countSkillFiles(skillRoots),
    skillRoots,
  };
}

function canRunPluginHooks(_loaded: LoadedPlugin): boolean {
  // 三方 marketplace 插件 hook 默认放行（与内置/官方一致）。
  // 上限：放弃了「仅官方可执行 hook」的信任边界，三方插件 hook 会直接执行；
  // 升级路径：需要逐插件 trust（如 user config 白名单）时，把判断收回这里。
  return true;
}

function warnUnsupportedComponents(loaded: LoadedPlugin, diagnostics: PluginDiagnostic[]): void {
  for (const key of UNSUPPORTED_COMPONENT_KEYS) {
    if (key in loaded.manifest) {
      diagnostics.push({
        code: "plugin_unsupported_component",
        message: `Plugin component is diagnostic-only in this ZCode runtime: ${key}`,
        path: loaded.manifestPath,
        pluginId: loaded.id,
        severity: "warning",
      });
    }
  }
}

function resolveSkillRoots(
  input: { diagnostics: PluginDiagnostic[]; loaded: LoadedPlugin },
  priority: number,
): SkillRoot[] {
  warnEmptyDeclaredSkillRoots(input);
  return resolveComponentRoots("skills", input, priority);
}

/**
 * manifest 显式声明的 skills 路径没有可用技能时发出诊断，避免路径配置错误静默失败。
 * 声明集合独立于 roots 列表计算，默认 skills/ 目录为空时不误报；路径缺失、目录为空和
 * 符号链接越界分别保留可操作的诊断信息，权限错误交给实际扫描链路报告。
 */
function warnEmptyDeclaredSkillRoots(input: {
  diagnostics: PluginDiagnostic[];
  loaded: LoadedPlugin;
}): void {
  const declared = parsePathList(input.loaded.manifest.skills);
  if (declared.length === 0) return;
  const seenPaths = new Set<string>();
  for (const rawPath of declared) {
    const resolved = resolveInside(input.loaded.rootPath, rawPath);
    if (!resolved || seenPaths.has(resolved)) continue;
    seenPaths.add(resolved);
    // 路径缺失判定只认 ENOENT/ENOTDIR（statSync 精确分类），EACCES 等权限
    // 错误不得误报成「不存在」——此时没有证据下结论，跳过告警，由 skill adapter
    // 扫描同一目录时发 skill_scan_failed。
    // message 按原因区分：「路径不存在」是 manifest 配错，「存在但没有技能」
    // 是内容问题，「symlink 逃逸出插件根」是安全拒绝，三者修复方式不同；
    // code 保持单一，UI 无需感知分类。
    if (isMissingPath(resolved)) {
      input.diagnostics.push({
        code: "plugin_skill_root_empty",
        message: `Plugin skills path does not exist: ${rawPath}`,
        path: resolved,
        pluginId: input.loaded.id,
        severity: "warning",
      });
      continue;
    }
    // 信任边界：声明路径是插件内容，扫描不跟随符号链接（目录级/文件级逃逸
    // 一并拒绝，含 Windows junction）。链接根/链接 SKILL.md 扫描为空后落入下方
    // 「没有任何技能」告警，不误报「不存在」（词法路径本身存在）。
    let skillFiles: string[];
    try {
      skillFiles = scanSkillFilesUnderRootSync(resolved, { followSymbolicLinks: false });
    } catch {
      continue;
    }
    if (skillFiles.length > 0) continue;
    input.diagnostics.push({
      code: "plugin_skill_root_empty",
      message: `Plugin skills path does not contain any skills: ${rawPath}`,
      path: resolved,
      pluginId: input.loaded.id,
      severity: "warning",
    });
  }
}

function resolveCommandRoots(
  input: { dataPath: string; diagnostics: PluginDiagnostic[]; loaded: LoadedPlugin },
  priority: number,
): CustomCommandRoot[] {
  const roots = resolveComponentRoots<CustomCommandRoot>(
    "commands",
    input,
    priority,
    createHookPluginContext(input.loaded, input.dataPath),
  );
  const generatedRoot = materializeCommandMetadataRoot(input, priority + 1);
  if (generatedRoot) roots.push(generatedRoot);
  return roots;
}

function inspectPluginHooks(input: {
  dataPath: string;
  diagnostics: PluginDiagnostic[];
  loaded: LoadedPlugin;
  runnable: boolean;
}): PluginHookInspection {
  const inspection = emptyHookInspection();
  for (const source of listPluginHookSources({
    diagnostics: input.diagnostics,
    loaded: input.loaded,
  })) {
    const loaded = parsePluginHookEvents({
      diagnostics: input.diagnostics,
      loaded: input.loaded,
      pluginDataPath: input.dataPath,
      rawHooks: source.rawHooks,
      runnable: input.runnable,
      sourcePath: source.sourcePath,
      wrapper: source.wrapper,
    });
    mergeHookInspection(inspection, loaded);
  }

  return inspection;
}

function parsePluginHookEvents(input: {
  diagnostics: PluginDiagnostic[];
  loaded: LoadedPlugin;
  pluginDataPath: string;
  rawHooks: unknown;
  runnable: boolean;
  sourcePath: string;
  wrapper: boolean;
}): PluginHookInspection {
  const hooksRoot = input.wrapper
    ? isRecord(input.rawHooks)
      ? input.rawHooks.hooks
      : undefined
    : input.rawHooks;
  const inspection = emptyHookInspection();
  if (!isRecord(hooksRoot)) {
    input.diagnostics.push({
      code: "plugin_hook_invalid",
      message: input.wrapper
        ? "Plugin hooks file must contain a hooks object"
        : "Plugin manifest hooks entry must be an object, a path, or an array",
      path: input.sourcePath,
      pluginId: input.loaded.id,
      severity: "error",
    });
    return inspection;
  }

  const plugin = createHookPluginContext(input.loaded, input.pluginDataPath, input.sourcePath);
  for (const [eventName, matcherConfigs] of Object.entries(hooksRoot)) {
    if (!SUPPORTED_HOOK_EVENTS.has(eventName)) {
      input.diagnostics.push({
        code: "plugin_hook_unsupported_event",
        message: `Plugin hook event is not supported by this ZCode runtime: ${eventName}`,
        path: input.sourcePath,
        pluginId: input.loaded.id,
        severity: "warning",
      });
      continue;
    }
    if (!Array.isArray(matcherConfigs)) {
      input.diagnostics.push({
        code: "plugin_hook_invalid",
        message: `Plugin hook event must be an array: ${eventName}`,
        path: input.sourcePath,
        pluginId: input.loaded.id,
        severity: "error",
      });
      continue;
    }

    const event = eventName as HookEventName;
    for (const matcherConfig of matcherConfigs) {
      const validation = HookMatcherConfigSchema.safeParse(matcherConfig);
      if (!validation.success) {
        input.diagnostics.push({
          code: "plugin_hook_invalid",
          message: `Invalid plugin hook matcher for ${eventName}: ${validation.error.issues
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
            .join("; ")}`,
          path: input.sourcePath,
          pluginId: input.loaded.id,
          severity: "error",
        });
        continue;
      }
      const withPlugin: HookMatcherConfig = {
        ...validation.data,
        hooks: validation.data.hooks.map((hook) => attachPluginToHook(hook, plugin)),
      };
      (inspection.events[event] ??= []).push(withPlugin);
      for (const hook of validation.data.hooks) {
        inspection.details.push(
          toPluginHookDetail({
            event,
            hook,
            ...(validation.data.matcher !== undefined ? { matcher: validation.data.matcher } : {}),
            runnable: input.runnable,
            sourcePath: input.sourcePath,
          }),
        );
      }
    }
  }

  return inspection;
}

function toPluginHookDetail(input: {
  event: HookEventName;
  hook: HookConfig;
  matcher?: string;
  runnable: boolean;
  sourcePath: string;
}): PluginHookDetail {
  const detail: PluginHookDetail = {
    command: input.hook.command,
    event: input.event,
    runnable: input.runnable,
    sourcePath: input.sourcePath,
    type: input.hook.type,
  };
  if (input.matcher !== undefined) detail.matcher = input.matcher;
  if (input.hook.statusMessage !== undefined) detail.statusMessage = input.hook.statusMessage;
  if (input.hook.timeoutMs !== undefined) detail.timeoutMs = input.hook.timeoutMs;
  if (input.hook.type === "process") {
    if (input.hook.args !== undefined) detail.args = input.hook.args;
    return detail;
  }
  if (input.hook.async !== undefined) detail.async = input.hook.async;
  if (input.hook.shell !== undefined) detail.shell = input.hook.shell;
  if (input.hook.timeout !== undefined) detail.timeout = input.hook.timeout;
  return detail;
}

function createHookPluginContext(
  loaded: LoadedPlugin,
  dataPath: string,
  sourcePath?: string,
): HookPluginContext {
  return {
    dataPath,
    id: loaded.id,
    name: loaded.manifest.name,
    rootPath: loaded.rootPath,
    ...(sourcePath ? { sourcePath } : {}),
  };
}

function attachPluginToHook(hook: HookConfig, plugin: HookPluginContext): HookConfig {
  return {
    ...hook,
    plugin,
  };
}

function mergeHookEvents(
  target: Partial<Record<HookEventName, HookMatcherConfig[]>>,
  source: Partial<Record<HookEventName, HookMatcherConfig[]>>,
): void {
  for (const [eventName, matchers] of Object.entries(source) as Array<
    [HookEventName, HookMatcherConfig[]]
  >) {
    if (matchers.length > 0) {
      (target[eventName] ??= []).push(...matchers);
    }
  }
}

function mergeHookInspection(target: PluginHookInspection, source: PluginHookInspection): void {
  mergeHookEvents(target.events, source.events);
  target.details.push(...source.details);
}

function emptyHookInspection(): PluginHookInspection {
  return {
    details: [],
    events: {},
  };
}

function countSkillFiles(skillRoots: SkillRoot[]): number {
  // 技能识别规则收敛到共享 scan helper（根自身含
  // SKILL.md 时根自身是一个技能）；同时声明根与
  // 默认 skills/ 根会命中同一个 SKILL.md，必须按文件路径去重，否则计数翻倍。
  // 顺带修正漂移：只认 isDirectory() 会漏掉 symlink 技能子目录，统一 helper 后一并计入。
  // helper 只吞 ENOENT；权限错误（EACCES 等）会抛出，这里按原语义把该根计 0，
  // 真正的 skill_scan_failed 诊断由 skill adapter 在运行时扫描同一目录时发出。
  // 信任边界：这里只消费 plugin roots（resolveSkillRoots 产物），不跟随符号链接。
  const seenFiles = new Set<string>();
  for (const skillRoot of skillRoots) {
    try {
      for (const file of scanSkillFilesUnderRootSync(skillRoot.path, {
        followSymbolicLinks: skillRoot.source !== "plugin",
      })) {
        seenFiles.add(file);
      }
    } catch {
      // 概览计数降级为 0；扫描诊断由 skill adapter 负责。
    }
  }
  return seenFiles.size;
}

function resolveComponentRoots<T extends CustomCommandRoot | SkillRoot>(
  key: "commands" | "skills",
  input: { diagnostics: PluginDiagnostic[]; loaded: LoadedPlugin },
  priority: number,
  plugin?: HookPluginContext,
): T[] {
  const paths = parsePathList(input.loaded.manifest[key]);
  const defaultPath = join(input.loaded.rootPath, key);
  if (directoryExists(defaultPath)) {
    paths.unshift(key);
  }
  const roots: T[] = [];
  const seenPaths = new Set<string>();
  for (const rawPath of paths) {
    const path = resolveInside(input.loaded.rootPath, rawPath);
    if (!path) {
      input.diagnostics.push({
        code: "plugin_component_path_invalid",
        message: `Plugin ${key} path escapes plugin root: ${rawPath}`,
        path: input.loaded.manifestPath,
        pluginId: input.loaded.id,
        severity: "error",
      });
      continue;
    }
    if (seenPaths.has(path)) continue;
    seenPaths.add(path);
    roots.push({
      path,
      ...(plugin ? { plugin } : {}),
      ...(key === "skills" ? { pluginId: input.loaded.id } : {}),
      priority,
      scope: input.loaded.source === "official" ? "system" : "user",
      source: "plugin",
    } as T);
  }
  return roots;
}

function materializeCommandMetadataRoot(
  input: { dataPath: string; diagnostics: PluginDiagnostic[]; loaded: LoadedPlugin },
  priority: number,
): CustomCommandRoot | null {
  const spec = input.loaded.manifest.commands;
  if (!isRecord(spec)) return null;

  const generatedRoot = join(input.dataPath, "generated-commands");
  let wroteCommand = false;
  mkdirSync(generatedRoot, { recursive: true });

  for (const [rawName, rawMetadata] of Object.entries(spec)) {
    if (!isRecord(rawMetadata)) {
      input.diagnostics.push({
        code: "plugin_manifest_invalid",
        message: `Plugin command metadata must be an object: ${rawName}`,
        path: input.loaded.manifestPath,
        pluginId: input.loaded.id,
        severity: "error",
      });
      continue;
    }

    const name = normalizeGeneratedCommandName(rawName);
    if (!name) {
      input.diagnostics.push({
        code: "plugin_manifest_invalid",
        message: `Invalid plugin command name: ${rawName}`,
        path: input.loaded.manifestPath,
        pluginId: input.loaded.id,
        severity: "error",
      });
      continue;
    }

    const source = typeof rawMetadata.source === "string" ? rawMetadata.source : undefined;
    const content = typeof rawMetadata.content === "string" ? rawMetadata.content : undefined;
    if ((source && content) || (!source && !content)) {
      input.diagnostics.push({
        code: "plugin_manifest_invalid",
        message: `Plugin command '${rawName}' must provide exactly one of source or content`,
        path: input.loaded.manifestPath,
        pluginId: input.loaded.id,
        severity: "error",
      });
      continue;
    }

    let markdown = content;
    if (source) {
      const sourcePath = resolveInside(input.loaded.rootPath, trimRelativePrefix(source));
      if (!sourcePath) {
        input.diagnostics.push({
          code: "plugin_component_path_invalid",
          message: `Plugin command source escapes plugin root: ${source}`,
          path: input.loaded.manifestPath,
          pluginId: input.loaded.id,
          severity: "error",
        });
        continue;
      }
      if (!fileExists(sourcePath)) {
        input.diagnostics.push({
          code: "plugin_component_path_invalid",
          message: `Plugin command source file not found: ${source}`,
          path: sourcePath,
          pluginId: input.loaded.id,
          severity: "error",
        });
        continue;
      }
      markdown = readFileSync(sourcePath, "utf8");
    }
    if (markdown === undefined) continue;

    // 市场清单支持 commands object mapping 和 inline content。
    // ZCode 的 custom command loader 只扫描 markdown 根目录，因此把低风险命令内容
    // materialize 到插件 data 目录；生成路径不在 plugin root 外暴露，也不执行命令本身。
    writeFileSync(
      join(generatedRoot, `${name}.md`),
      applyCommandMetadataFrontmatter(markdown, rawMetadata),
      "utf8",
    );
    wroteCommand = true;
  }

  return wroteCommand
    ? {
        path: generatedRoot,
        plugin: createHookPluginContext(input.loaded, input.dataPath),
        priority,
        scope: input.loaded.source === "official" ? "system" : "user",
        source: "plugin",
      }
    : null;
}

function normalizeGeneratedCommandName(name: string): string | null {
  const normalized = name.trim().replace(/^\/+/, "").toLowerCase();
  if (!/^[a-z0-9][a-z0-9_:-]{0,63}$/.test(normalized)) return null;
  return normalized;
}

function trimRelativePrefix(path: string): string {
  return path.replace(/^\.\//, "");
}

function applyCommandMetadataFrontmatter(
  markdown: string,
  metadata: Record<string, unknown>,
): string {
  const frontmatter = new Map<string, string>();
  if (typeof metadata.description === "string" && metadata.description.trim()) {
    frontmatter.set("description", metadata.description.trim());
  }
  if (typeof metadata.argumentHint === "string" && metadata.argumentHint.trim()) {
    frontmatter.set("argument-hint", metadata.argumentHint.trim());
  }
  if (typeof metadata.model === "string" && metadata.model.trim()) {
    frontmatter.set("model", metadata.model.trim());
  }
  if (Array.isArray(metadata.allowedTools)) {
    const allowedTools = metadata.allowedTools
      .filter((tool): tool is string => typeof tool === "string" && tool.trim().length > 0)
      .map((tool) => tool.trim());
    if (allowedTools.length > 0) frontmatter.set("allowed-tools", allowedTools.join(", "));
  }
  if (frontmatter.size === 0) return markdown;
  const body = stripMarkdownFrontmatter(markdown).trimStart();
  return `---\n${Array.from(frontmatter, ([key, value]) => `${key}: ${value}`).join("\n")}\n---\n\n${body}`;
}

function stripMarkdownFrontmatter(markdown: string): string {
  const normalized = markdown.replace(/^\uFEFF/, "");
  if (!normalized.startsWith("---")) return markdown;
  const lines = normalized.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return markdown;
  const endIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  return endIndex > 0 ? lines.slice(endIndex + 1).join("\n") : markdown;
}

function scanOfficialCache(
  storageRoot: string,
  diagnostics: PluginDiagnostic[],
  options?: PluginAbortOptions,
): string[] {
  // 官方插件升级会保留旧版本缓存目录；若遍历全部目录再按插件 id
  // “先到先得”，旧版本会抢在 bundled marketplace 指向的当前版本前被加载。
  // bundled 分片是当前随应用发布资产的权威清单；存在时只加载其 cachePath。
  // 不能简单选择最高 semver，否则官方回滚版本时仍会错误加载旧缓存。
  const bundledRoots = loadBundledOfficialPluginRootsSync(storageRoot);
  if (bundledRoots !== undefined) {
    for (const rootPath of bundledRoots) {
      throwIfAborted(options);
    }
    return bundledRoots;
  }

  const cacheRoot = join(storageRoot, "cache", ZCODE_OFFICIAL_PLUGIN_MARKETPLACE);
  try {
    const roots: string[] = [];
    for (const pluginEntry of readdirSync(cacheRoot, { withFileTypes: true })) {
      throwIfAborted(options);
      if (!pluginEntry.isDirectory()) continue;
      const pluginDir = join(cacheRoot, pluginEntry.name);
      for (const versionEntry of readdirSync(pluginDir, { withFileTypes: true })) {
        if (versionEntry.isDirectory()) roots.push(join(pluginDir, versionEntry.name));
      }
    }
    return roots;
  } catch (error) {
    if (isNotFoundError(error)) return [];
    diagnostics.push({
      code: "plugin_root_not_found",
      message: error instanceof Error ? error.message : `Failed to scan ${cacheRoot}`,
      path: cacheRoot,
      severity: "warning",
    });
    return [];
  }
}

function loadPlugin(
  candidate: PluginCandidate,
  diagnostics: PluginDiagnostic[],
): LoadedPlugin | null {
  if (!directoryExists(candidate.rootPath)) {
    diagnostics.push({
      code: "plugin_root_not_found",
      message: `Plugin root does not exist: ${candidate.rootPath}`,
      path: candidate.rootPath,
      severity: "warning",
    });
    return null;
  }

  const manifestPath = findManifest(candidate.rootPath);
  if (!manifestPath) {
    diagnostics.push({
      code: "plugin_manifest_not_found",
      message: `Plugin manifest not found: ${candidate.rootPath}`,
      path: candidate.rootPath,
      severity: "error",
    });
    return null;
  }

  const manifest = readManifest(manifestPath, diagnostics);
  if (!manifest) return null;
  return {
    id: `${manifest.name}@${candidate.marketplace}`,
    manifest,
    manifestPath,
    marketplace: candidate.marketplace,
    rootPath: candidate.rootPath,
    source: candidate.source,
  };
}

function findManifest(rootPath: string): string | null {
  const zcodePath = join(rootPath, ZCODE_MANIFEST_PATH);
  if (fileExists(zcodePath)) {
    return zcodePath;
  }

  // 兼容不同 manifest 目录约定，发现阶段按稳定优先级回退。
  const claudePath = join(rootPath, CLAUDE_MANIFEST_PATH);
  if (fileExists(claudePath)) {
    return claudePath;
  }
  const codexPath = join(rootPath, CODEX_MANIFEST_PATH);
  return fileExists(codexPath) ? codexPath : null;
}

function readManifest(path: string, diagnostics: PluginDiagnostic[]): PluginManifest | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isRecord(parsed)) throw new Error("Manifest must be a JSON object");
    const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
    if (!PLUGIN_NAME_PATTERN.test(name)) throw new Error(`Invalid plugin name: ${name}`);
    return {
      ...parsed,
      name,
      version: typeof parsed.version === "string" ? parsed.version : DEFAULT_VERSION,
    } as PluginManifest;
  } catch (error) {
    diagnostics.push({
      code: "plugin_manifest_invalid",
      message: error instanceof Error ? error.message : `Invalid plugin manifest: ${path}`,
      path,
      severity: "error",
    });
    return null;
  }
}

function emptyOutcome(): PluginLoadOutcome {
  return {
    commandRoots: [],
    diagnostics: [],
    hooks: {},
    mcpServers: {},
    plugins: [],
    skillRoots: [],
  };
}

function emptyComponents(hookDetails: PluginHookDetail[] = []): PluginComponents {
  return {
    commandRoots: [],
    hooks: {},
    hookDetails,
    mcpServers: {},
    skillCount: 0,
    skillRoots: [],
  };
}

function resolveEnabled(config: PluginConfig, id: string, defaultEnabled: boolean): boolean {
  return config.enabledPlugins[id] ?? defaultEnabled;
}
