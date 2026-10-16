# Model Provider Catalog And Metadata Design

## 背景

当前模型供应商链路已经分成两层事实源：

- Host `modelProviderService` 管理 app 侧 provider 配置、API Key、endpoint、catalog 导入和落盘。
- ZCode Agent server 接收 Host 生成的 provider registry snapshot，并维护运行态模型目录、当前模型和 reasoning/thought level。

设置页已经支持从 `models.dev` 导入 provider、自定义 provider、编辑模型 id 列表和 provider 基础字段。聊天框在 ZCode Agent 路径下优先使用 agent 返回的 `settings.model.available/current`，Host provider registry 通过 `workspace/updateProviderRegistry` 热同步给 agent。

现在要把开发阶段的中国 LLM catalog、provider 拖拽排序和单模型运行时 metadata 纳入正式设计。该设计只描述 app/host/agent registry 之间的契约与实现边界，不改变远控链路的 ownership 规则。

## 目标

- 接入 `models_catalog_china_llm_zcode_2026-06-03.json` 作为开发阶段临时 catalog source，并为后续 CDN 下载保留清晰迁移点。
- catalog 数据模型贴合 `zcode.model-providers.v1` JSON schema：保留 `kind`、`endpoints.baseURL + paths`、`model.kinds`、`modalities` 和 reasoning patch，不伪装成 `models.dev`。
- provider 排序支持拖拽，排序结果持久化，并由 UI 同时应用到设置页 provider 导航和聊天框 provider 分组顺序。
- 单模型字段从旧的 `string[] + metadata map` 收敛成模型对象数组，避免新旧字段长期双写。
- catalog 导入后的模型能力进入 `ModelProviderConfig`，再由 `convertModelProviderConfigToZCodeProviderInput` 投影到 ZCode Protocol 的 `ZCodeModelProviderInput.models[*]`。
- 保持桌面、本地远程 workspace、手机 `/remote` shared-host attachment 的 provider registry 同步语义不变。

## 非目标

- 不在本阶段实现 CDN 服务、签名校验、增量更新或离线缓存策略。
- 不把 provider 拖拽排序做成改变 provider 来源分组的操作；拖拽只改变展示相对顺序，不改变 `source`、预置身份或官方 OAuth 身份。
- 不把单模型编辑扩展成完整价格、限流、区域、计费和多 endpoint fallback 管理。
- 不让 UI 在 `session/send` 时携带 provider/model metadata；运行时仍只使用 agent server 已应用的 workspace model catalog。
- v1 不提供任意 reasoning patch JSON 编辑器。reasoning patch 先来自 catalog 或迁移逻辑，避免用户在 UI 中写出格式正确但运行时不可用的参数。

## 当前约束

- `models_catalog_china_llm_zcode_2026-06-03.json` 遵循 `zcode.model-providers.v1` schema。它的 `endpoints.paths` key 是 runtime `kind`：`anthropic`、`openai`、`openai-compatible`；公开 JSON 中不能出现 AI SDK 内部命名 `openaiCompatible`。
- `endpoints.baseURL + endpoints.paths[kind]` 描述该 kind 的请求地址。当前 app/agent 协议只有单个 effective provider kind/baseURL，因此导入和投影必须显式选择 effective kind，不能在统一 catalog model 中提前丢掉其他 kind。
- `model.kinds` 表示单模型支持的接口格式，并且必须存在于 provider 的 `endpoints.paths` 中。`modalities` 是模型输入/输出能力来源，UI 的 `supportsImages` 等布尔值应由它推导。
- `reasoning.levels[level][kind]` 是请求参数 patch，不是最终 providerOptions，也不包含 UI label、rank 或 enabled。转换层需要把公开 JSON 的 `openai-compatible` namespace 映射成 AI SDK 内部的 `openaiCompatible`。
- 现有 `ModelProviderConfig.models` 是 `string[]`，但如果本阶段正式切换到模型对象数组，就必须提供旧 `model-providers.json` 的一次性自动迁移，否则升级用户的 provider 会因为 schema 不匹配而丢失或读不出来。
- 现有 `sortModelProvidersForDisplay` 会按内置 provider bucket 重排，普通数组顺序不能代表用户排序。
- ZCode Protocol 已有 `ZCodeModelReasoningState`：
  - `enabled`
  - `levels: { value, label, description? }[]`
  - `defaultLevel?`
  - `providerOptionsByLevel?`

## Catalog Source 设计

### Source 分层

新增 app 侧 catalog source 抽象，不把中国 LLM catalog 伪装成 `models.dev` 原始 schema。

```ts
type ModelProviderCatalogSourceId =
  | "models-dev"
  | "china-llm-zcode-dev";

interface ModelProviderCatalogSource {
  id: ModelProviderCatalogSourceId;
  label: string;
  load(): Promise<ModelProviderCatalogFile>;
}
```

`models-dev` 继续从 `https://models.dev/api.json` 获取，但解析后也转换成 app 内统一 catalog file。`china-llm-zcode-dev` 在开发阶段从仓库根目录的 `models_catalog_china_llm_zcode_2026-06-03.json` 读取。

`catalogSourceId` 只表示“从哪个 catalog 导入”，不得混用为 provider 的产品来源分组。provider 的 `source` 仍只表达 `builtin`、`models-dev`、`custom`、`workspace` 等产品语义；如果后续要新增产品来源，必须正式扩展 shared schema、protocol source schema 和 UI 分组逻辑。

### 统一 catalog model

内部统一 catalog model 直接贴合公开 JSON schema，避免在 source adapter 阶段丢字段：

```ts
type ModelProviderKind = "anthropic" | "openai" | "openai-compatible";
type Modality = "text" | "image" | "video" | "audio" | "pdf";

interface ModelProviderCatalogFile {
  schemaVersion: "zcode.model-providers.v1";
  providers: ModelProviderCatalogProvider[];
}

interface ModelProviderCatalogProvider {
  id: string;
  name: string;
  endpoints: {
    baseURL: string;
    paths: Partial<Record<ModelProviderKind, string>>;
  };
  defaultKind?: ModelProviderKind;
  models: ModelProviderCatalogModel[];
}

interface ModelProviderCatalogModel {
  id: string;
  name?: string;
  kinds: ModelProviderKind[];
  defaultKind?: ModelProviderKind;
  modelIdByKind?: Partial<Record<ModelProviderKind, string>>;
  modalities: {
    input: Modality[];
    output: Modality[];
  };
  contextWindow: number;
  maxOutputTokens?: number;
  reasoning?: ModelProviderReasoningSpec;
}

interface ModelProviderReasoningSpec {
  defaultLevel?: string;
  levels: Record<string, Partial<Record<ModelProviderKind, ProviderOptionsPatch>>>;
}

interface ProviderOptionsPatch {
  set?: Array<{ path: string[]; value: unknown }>;
  unset?: Array<{ path: string[] }>;
}
```

`models.dev` adapter 负责把旧字段转换为这个模型：

- provider `api` 进入一个 effective kind 的 endpoint。
- `attachment` / `modalities.input` 转成 `modalities`，不生成持久化的 `supportsImages` 字段。
- `tool_call`、`structured_output` 这类 `models.dev` 独有布尔能力只作为导入时的可选 runtime metadata；如果当前统一 schema 没有字段承载，不应塞进无关字段。
- 只有 `supportsReasoning: true` 但没有 level/patch 明细时，不生成假的 reasoning levels；这类模型仅在 UI 上展示“可能支持 reasoning”，不向 agent 声明可选择的 thought levels。

### 临时本地文件与 CDN 迁移点

开发阶段 `china-llm-zcode-dev` source 读取本地 JSON 文件。该 source 的 loader 需要集中定义未来 CDN URL 迁移点，并在文档中记录：

- 当前阶段：读取本地 catalog 文件，便于快速开发和审核。
- CDN 阶段：同一 source id 改为通过 `ApiClient` 下载 JSON，保留本地开发 fallback。
- 切换 CDN 不改变统一 catalog model、provider 配置落盘 schema 或 agent registry 投影。

## Provider 配置设计

### 新落盘结构

不再新增 `modelMetadata` map，也不再长期维护 `modelDisplayNames` / `modelSupportedFormats` 双写。新的落盘结构把模型 id 和 metadata 放在同一个对象里：

```ts
interface ModelProviderStoreFile {
  schemaVersion: "zcode.model-providers.v2";
  providers: ModelProviderConfig[];
}

interface ModelProviderConfig {
  id: string;
  name: string;
  enabled?: boolean;
  systemDisabledReason?: ModelProviderSystemDisabledReason;
  source?: ModelProviderSource;
  catalogSourceId?: ModelProviderCatalogSourceId;
  catalogProviderId?: string;
  apiKey: string;
  apiKeyRequired?: boolean;
  apiKeyUrl?: string;
  headers?: Record<string, string>;
  logoUrl?: string;
  endpoints: {
    baseURL: string;
    paths: Partial<Record<ModelProviderKind, string>>;
  };
  defaultKind?: ModelProviderKind;
  models: ModelProviderModelConfig[];
  providerMappings?: ProviderModelMappings;
  createdAt: number;
  updatedAt: number;
}

interface ModelProviderModelConfig extends ModelProviderCatalogModel {
  disabledReason?: string;
}
```

这样做的原因是：新 catalog 的核心事实已经是模型对象。继续保留 `models: string[]` 再用多个 map 补 metadata，会让模型改名、删除、排序、导入和投影都必须同步维护多个索引，复杂度高且容易产生孤儿 metadata。

### 旧数据自动迁移

需要旧 `model-providers.json` 的自动迁移逻辑。这里的“迁移”不是长期兼容旧字段，而是在读取旧文件时一次性转换为新结构，并在转换成功后原子写回 v2。

读取逻辑：

1. 如果文件是 `{ schemaVersion: "zcode.model-providers.v2", providers: [...] }`，按新 schema 读取。
2. 如果文件是旧版裸数组，先按旧 `modelProviderListSchema` 解析，再转换成 v2。
3. 如果解析失败，不覆盖原文件；记录 warn，并降级为空列表或现有安全 fallback。
4. 写回 v2 前先保留备份，例如 `model-providers.v1.backup.json`。备份失败不应阻塞读取，但必须记录 warn。

旧 provider 到 v2 的转换规则：

- `models: string[]` 转为 `models: ModelProviderModelConfig[]`，每个模型至少包含 `id`、`name`、`kinds`、`modalities` 和保守的 `contextWindow`。
- `modelDisplayNames[modelId]` 转为模型 `name`。
- `modelSupportedFormats[modelId]` 转为模型 `kinds`：
  - `anthropic` -> `anthropic`
  - `openai` -> `openai-compatible`
  - `responses` -> `openai`
  - `gemini` 当前没有对应 `ModelProviderKind`，迁移时不写入 `kinds`；如果某模型只剩 `gemini`，保留 provider 但禁用该模型或标记 `disabledReason`，避免静默生成不可用运行时配置。
- 旧 `apiFormat` 决定 provider 的 `defaultKind`：
  - `anthropic-messages` -> `anthropic`
  - `openai-chat-completions` -> `openai-compatible`
  - `openai-responses` -> `openai`
- 旧 `endpoints.anthropic` / `endpoints.openai` 是历史 adapter-ready URL，无法可靠拆成 `baseURL + path`。迁移时把选中的 legacy endpoint 原样放入 `endpoints.baseURL`，对应 `paths[kind]` 设为空字符串，并通过注释或测试固定该语义：空 path 表示 legacy baseURL 已经包含 adapter 所需路径。
- `providerMappings`、`enabled`、`systemDisabledReason`、`apiKey`、`headers`、`createdAt`、`updatedAt` 原样保留。

没有这段迁移，升级后的新 schema 会把旧数组当作无效文件，用户已有 provider、API Key、模型列表和开关状态都有丢失风险。

## Provider 排序设计

### 状态归属

provider 展示顺序是 UI/设置偏好，不影响 agent 请求行为。它不进入 `ZCodeModelProviderInput`，也不因为单纯排序变更触发 provider registry revision。

排序持久化独立于 provider runtime config：

```ts
interface ModelProviderDisplayOrderState {
  providerIds: string[];
  updatedAt: number;
}
```

推荐由 `modelProviderService` 提供独立方法读取和保存该状态，落盘文件可独立于 `model-providers.json`。这样拖拽排序不会误触发 `onDidChangeProviderRegistry`，也不会让远端 agent 因展示顺序变化重建 provider catalog。

### 排序规则

展示排序函数接收 provider 列表和可选用户排序：

1. 已在 `providerIds` 中的 provider 按该顺序展示。
2. 新增但未出现在 `providerIds` 中的 provider 按当前 bucket fallback 排到对应组尾部。
3. 已删除 provider 的 id 在保存下一次排序时清理。
4. provider 的来源分组仍由现有规则决定，拖拽不改变分组身份。

排序应用点必须明确分成两处：

- 设置页导航：在每个可拖拽分组内应用 display order。
- 聊天框模型选择器：先按 agent 返回的 `settings.model.available` 构建 provider 分组，再按本地 display order 重排分组；组内模型顺序仍使用 agent/catalog 顺序。这样 display order 不需要进入 registry，也能影响聊天框展示。

`buildProviderRegistrySnapshot` 仍可按稳定规则排序 provider 以保证 revision 可复现。只编辑 display order 不调用 `convertModelProviderConfigToZCodeProviderInput`，也不改变 provider registry revision。

### 拖拽交互

使用项目已有 `@dnd-kit`：

- 左侧 provider 导航项显示 `GripVertical` 拖拽把手。
- 只有真实 provider 节点可拖拽；`添加供应商`、loading 节点、分组标题不可拖拽。
- 预置分组、自定义分组、官方分组保持分组边界。跨分组拖拽不改变 provider source，v1 不支持跨分组移动。
- 拖拽结束后 optimistic 更新本地顺序并保存；保存失败时恢复前一顺序并通过 UI logger 记录 warn。
- 键盘可访问性沿用 `@dnd-kit` sortable 默认 attributes/listeners，拖拽按钮有国际化 aria-label 和 tooltip。

## Reasoning 设计

### 数据边界

落盘和 catalog 中的 reasoning 只保留运行时事实：

- `defaultLevel`
- `levels[level][kind].set`
- `levels[level][kind].unset`

不落盘 UI label、description、rank 或 `enabled`。UI 展示 label 由 i18n 根据 level id 派生，例如 `off`、`enabled`、`high`、`max`；未知 level 直接显示原始 value。

### 投影到 ZCode Protocol

`convertModelProviderConfigToZCodeProviderInput` 构造每个 `models[*]` 时：

1. 选择 effective kind：`model.defaultKind ?? provider.defaultKind`。
2. 校验 effective kind 存在于 `model.kinds` 和 `provider.endpoints.paths`。不满足时禁用该模型或跳过，并记录 warn。
3. 选择运行时模型名：`model.modelIdByKind?.[effectiveKind] ?? model.id`。
4. 从 `modalities.input` 推导 `supportsImages`；`supportsTools`、`supportsJsonSchemaOutput` 如需要支持，应作为独立 schema 字段补充，不能从无关字段猜。
5. 透传 `contextWindow`、`maxOutputTokens`。
6. 如果存在 `reasoning.levels`，为每个 level 取当前 effective kind 的 patch，并转换成 `providerOptionsByLevel[level]`：
   - `set` 按 path 写入嵌套对象。
   - `unset` 在生成 provider options 时删除对应 path，或用统一 sentinel 在最终运行时应用前删除。
   - namespace 映射为 `anthropic -> anthropic`、`openai -> openai`、`openai-compatible -> openaiCompatible`。
7. 生成 `ZCodeModelReasoningState.levels` 时只填 `{ value, label }`，label 由 i18n/本地映射生成。
8. `defaultLevel` 只有在存在于 levels 中时透传；否则使用第一个 level。

如果模型没有 reasoning patch，不生成 label-only level，也不声明可选择 thought levels。

### 设置页编辑

v1 只提供低风险编辑：

- Provider：名称、API Key、baseURL、kind paths、默认 kind。
- Model：模型 id、显示名、支持 kinds、默认 kind、modalities、context window、max output tokens。
- Reasoning：查看 catalog 已有 levels，允许启用/禁用已有 level；删除当前默认 level 后按归一化规则选择剩余第一个 level 作为默认。

v1 不提供“新增任意 reasoning level”或“高级 JSON 参数编辑”。原因是 reasoning patch 是运行时请求参数，不是展示配置；没有 provider 文档和测试支撑时，UI 很容易保存出 agent 可选择但请求不可用的 level。后续如果要支持自定义 patch，应做成单独高级功能，并复用 catalog schema 的 patch editor 和连通性测试。

## Agent Registry 投影

`convertModelProviderConfigToZCodeProviderInput` 需要把 v2 provider config 投影到当前 ZCode Protocol：

- provider `kind` 使用 effective kind。
- provider `baseURL` 使用按 effective kind 解析后的 runtime baseURL。legacy 迁移产生的空 path 表示 `baseURL` 已经是旧 adapter-ready URL。
- `models[*].modelId` 使用 kind-aware 模型名。
- `models[*].label` 使用模型 `name`。
- `models[*].contextWindow`、`maxOutputTokens`、`supportsImages` 从模型对象透传/推导。
- `models[*].reasoning` 使用 patch 转换后的 `ZCodeModelReasoningState`。
- `models[*].providerOptions.supportedFormats` 不再作为主要事实源；如果当前 agent 仍依赖它过滤格式，可在投影阶段由 `model.kinds` 临时生成，后续收敛到 kind 语义。

修改 provider/model runtime metadata 会触发 registry snapshot revision，影响下一轮 turn。只修改 display order 不触发 registry snapshot revision。

## 远控和多端边界

- 手机 `/remote` 仍通过 shared-host attachment 连接桌面窗口已存在的 host，不创建独立 provider runtime。
- provider metadata 仍由本机 Host provider registry snapshot 下发到远端 workspace agent server。
- `workspaceIdentity` 继续用于远程 workspace provider registry sync 的身份隔离；新增 display order 若作为 app 全局偏好，不使用 workspace identity 分片。
- desktop continuous 和 mobile web-remote replayable 的 session 事件语义不变。provider registry 更新仍走 workspace state update，不把 replayable snapshot 语义扩散到 desktop continuous 主链路。

## 日志

- UI 拖拽保存失败、reasoning level 归一化失败等交互日志使用 `packages/ui/src/logger.ts`。
- catalog 加载、解析失败、CDN 下载失败、旧 provider 配置迁移成功/失败等服务层日志使用 `createServiceLogger("ModelProviderService")` 或同等服务 logger。高频路径不打 info。
- provider registry revision 变化只在 metadata/provider 行为变化时记录；display order 保存不记录为 registry 更新。

## 测试与验收

- shared schema 测试覆盖：
  - `zcode.model-providers.v1` catalog file 解析。
  - `zcode.model-providers.v2` provider store 解析。
  - 旧裸数组 `model-providers.json` 自动迁移到 v2。
  - reasoning patch 的 `set` / `unset` 校验和 namespace 映射。
  - `convertModelProviderConfigToZCodeProviderInput` 透传 context、output、modalities 推导能力和 reasoning。
- service 测试覆盖：
  - `models.dev` adapter 继续可用，并输出统一 catalog model。
  - `china-llm-zcode-dev` adapter 能解析本地 catalog。
  - 旧 provider 配置迁移后 API Key、enabled、providerMappings、模型显示名和模型格式不丢。
  - display order 保存不触发 provider registry changed event。
- UI 测试覆盖：
  - 设置页 provider 导航拖拽后顺序持久化。
  - 添加供应商从 catalog 导入后模型对象正确进入草稿。
  - 单模型 reasoning levels 可以启用/禁用；删除默认 level 后按归一化规则修正。
  - 只编辑 display order 时，设置页和聊天框 provider 分组顺序变化，但 agent registry snapshot revision 不变化。
- 手动验证覆盖：
  - 桌面本地 workspace：导入 catalog provider，设置 API Key，聊天框可见模型 metadata。
  - 远程 workspace：provider registry snapshot 同步后远端 agent 可见相同模型能力。
  - 手机 `/remote`：重连后模型列表来自已 attach host 的 agent state，不创建独立 provider runtime。

## 实施顺序

1. 扩展 shared 类型和 schema，新增 catalog schema、provider store v2 schema 和旧数据迁移函数。
2. 抽象 catalog source，并把 `models.dev` 与本地中国 LLM catalog 都转换到统一 catalog model。
3. 修改 provider 导入逻辑，让 catalog model 写入 v2 `ModelProviderConfig.models` 对象数组。
4. 修改 agent registry 投影，支持 effective kind、modalities 推导和 reasoning patch 转换。
5. 新增 display order 读取/保存服务接口与 UI hook。
6. 改造 provider 导航排序和拖拽交互。
7. 改造聊天框 provider 分组排序，在 UI 侧应用 display order。
8. 改造单模型编辑 UI，聚焦模型对象字段和已有 reasoning level 的启用/禁用。
9. 补齐测试、运行 `pnpm typecheck` 和 `pnpm lint`。

## 后续事项

中国 LLM catalog 的 CDN 化是明确后续事项：在开发阶段使用本地 `models_catalog_china_llm_zcode_2026-06-03.json`，等 catalog 审核和发布流程稳定后，把 `china-llm-zcode-dev` loader 切换为 CDN 下载，并保留本地 fallback 供开发调试。该切换不得改变 provider 落盘 schema 或 ZCode Protocol 投影。
