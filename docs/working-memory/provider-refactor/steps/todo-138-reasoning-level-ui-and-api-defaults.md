# Todo138：空模型草稿与 Model 层推理档位兜底

> 状态：已完成。2026-09-12；按最终裁决实施并通过下述验证。

> 合并说明：来源分支编号为 Todo134，现统一为 Todo138。来源实现的 builtin revision 为 23；合并另一份 revision 23 的 Turbo 禁用改动后升为 24，正文旧版本记录保留为历史证据。

## 背景与最终裁决

新增模型未填写 ID 就显示 disabled，来源是 ProviderCardSections.createEmptyModel 的 UI 硬编码。用户要求空白草稿不预填档位，实际模型提供关闭/开启两档兜底。

讨论后撤回“Model 通用档位留空、API 层新增两档”的初稿：现有 Model + API 规则后置覆盖，会覆盖 Model 层专用档位。最终不改层级、排序、overlay 算法，不引入字段特例，也不跨层重复声明专用档位。

## 修改后的状态

### 新增模型 UI

未填写模型 ID 时，推理档位为空，不预填 disabled。可添加档位；输入 ID 后沿用现有解析、草稿投影、个人覆盖机制。清空 ID 不发解析请求；没有用户覆盖时回到空档位。有显式编辑的档位继续保留。已有模型、手动设置及其他初始能力不被重置。

### Model 层通用兜底

```ts
reasoningLevel: {
  values: ["disabled", "enabled"],
  map: "{}",
}
```

已知模型继续用后续专用规则声明自己的档位，不要求每个模型额外添加 disabled/enabled。无 API 信息时也可得到 Model 层两档，但不代表配置完整或可发请求；不放宽完整性校验。

### 三种 API 通用映射

API 通用规则不新增 values，只修改 map 的 enabled 分支：

- Anthropic Messages：disabled 保持 thinking.type=disabled；enabled 使用 thinking.type=adaptive、output_config.effort=high。
- OpenAI Chat Completions：disabled 保持关闭字段及 effort=none；enabled 使用 thinking.type=enabled、enable_thinking=true，reasoning_effort 和 reasoning.effort 均为 high。
- OpenAI Responses：disabled 保持 reasoning.effort=none；enabled 映射 reasoning.effort=high。

其他档位按原映射处理，模型/API/站点专用 map 和个人覆盖保持。只调整通用表达式，不把 enabled 作为接口 effort 原样发出。

## 所有权与边界

```text
空 ID 草稿（UI，空档位，不解析）
  -> 输入 ID
  -> 现有 Host 解析：Model 通用两档 -> 专用模型档位 -> 原有后层覆盖
  -> 现有 UI 投影（保留显式编辑）
  -> 现有请求适配器执行 API map
```

UI 只拥有未提交草稿；规则和有效模型配置仍由 Provider 解析链路负责。不增加协议、状态源、定时器或同步链，不改变桌面 continuous / 手机 replayable 边界。两端复用相同编辑组件。

用户主动选模型或全新初始化时，completeNewModelSelection 取档位数组最后一项，因而会为兜底模型选到 enabled；恢复/重解析已有选择不走此补全策略；本次接受两档的自然结果，不修改选档策略，不覆盖用户已保存选择。builtin revision 从 22 递增到 23，不改 schemaVersion，不增加文件格式或迁移。

## 实施与验收

- [x] 更新空模型初始值，补首次打开、输入 ID 后解析、清空、手动编辑保留的回归。
- [x] 验证真实内置规则的通用两档、专用档位和个人 map 覆盖；不修改解析器。
- [x] 执行三种 API 通用 CEL，并捕获真实 SDK 最终请求体验证 disabled/enabled（对应 high），其他强度由 CEL 和既有专用请求用例回归。
- [x] 浏览器覆盖桌面/手机宽度、深浅主题和中英文，记录运行结果；不冒充完整 Electron/远控验证。
- [x] 更新相关 spec/索引，运行相关单测、类型、lint、架构检查后提交。

## 代码定位

- UI：packages/ui/src/settings/model-provider-section/ProviderCardSections.tsx。
- 解析/投影：useModelConfigResolution.ts、useProviderModelDraft.ts、ProviderModelDraftState.ts（仅回归，不改生命周期）。
- 内置：config/provider/zcode-builtin.json 第一条 Model 规则与三条通用 Model + API map。
- 规则顺序：packages/provider/src/config/schema.ts、model-config.ts（保持现状）。

## 验证记录

- 先红后绿：UI 初始档位、真实内置解析、SDK 未声明 enabled 校验及两种尺寸浏览器均先复现旧行为。
- 相关 UI/内置配置单测 153 项通过；草稿规则 7 项通过；真实 SDK 序列化请求 64 项通过（含三种格式 disabled/enabled 共6项），使用隔离 fetch，不请求付费模型。
- 类型检查、desktop E2E 类型检查通过；Lint 42 条既有警告、0 错误；架构检查 0 违规。
- 专用 map 历史基线及 GPT-5.4、GLM-5.3 多档位保持。Grok-4.3 没有专用档位声明，因此与未知模型一样继承两档；其内置默认关闭状态未改。个人持久化不回写。
- 浏览器新增用例两项通过；校验首次打开无档位/无请求，解析后两档，清空 ID 回到空列表，以及手动编辑不被后续回包覆盖。测试曾误等待推荐输入的 value，按运行记录改为等待 placeholder，不改生产同步逻辑。
- 浏览器测试使用共享组件及隔离服务，未执行完整 Electron、手机远控或真实供应商联网调用。

共用设置页浏览器合跑 22 项：21 项直接通过，手机 provider batch 被本次注释整理触发的 Vite HMR 打断；文件固定后两项 provider batch 重跑均通过。测试故障不涉及产品修复。新增两项也已独立通过。
