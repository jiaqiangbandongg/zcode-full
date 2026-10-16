# Model Provider Catalog Metadata

> 历史文档：本文描述的方案先被 OpenCode config 过渡方案取代，随后又被 Provider Refactor
> 取代。当前权威设计见 `docs/working-memory/provider-refactor/design/`；
> `docs/model-provider-opencode-config.md` 同样只保留为历史迁移记录。本文描述的是已经被取代的
> `models_catalog_china_llm_zcode_2026-06-03.json` 和 `model-providers.v2.json`
> 方案，只作为历史背景保留。

## 范围

本功能把开发阶段的中国 LLM catalog、provider 展示排序和单模型运行时 metadata 纳入正式 provider 配置链路。当前只覆盖桌面端本地项目的 app/host/agent 同步；SSH 远程和手机 `/remote` 沿用既有 shared-host attachment 边界，没有新增独立 runtime。

## Catalog Source

`modelProviderService.getCatalogProviders(sourceId)` 统一返回 app 内 catalog model：

- `models-dev`：从 models.dev schema 转成统一 catalog。
- `china-llm-zcode-dev`：读取仓库根目录 `models_catalog_china_llm_zcode_2026-06-03.json`。

中国 LLM catalog 的 `endpoints.baseURL + endpoints.paths[kind]` 表示完整请求地址。写入 agent registry 前会归一化成运行时 SDK 需要的 API base URL，避免 OpenAI compatible SDK 再追加 `/chat/completions` 时生成重复路径。

## Historical Provider Store

历史方案中，用户 provider 配置落盘为独立 v2 文件 `model-providers.v2.json`：

```json
{
  "schemaVersion": "zcode.model-providers.v2",
  "providers": []
}
```

`models` 支持模型对象数组，模型的 `kinds`、`modalities`、`contextWindow`、`maxOutputTokens`、`reasoning` 与 id 保存在同一个对象里。旧的 `model-providers.json` 裸数组和 legacy metadata map 会在读取时迁移为模型对象，并写入 `model-providers.v2.json`；旧文件保持不变，避免用户回退到老版本后无法读取原配置。若检测到旧实现已经把 v2 store 写进 `model-providers.json`，且存在 `model-providers.v1.backup.json`，会恢复旧文件供老版本读取，新版本继续使用 v2 store。

展示顺序独立保存在 `model-provider-display-order.json`。排序只影响设置页导航和聊天页 provider 分组展示，不改变 provider 来源、身份或 runtime registry key。

## Settings Editing

provider 设置页支持编辑：

- provider 名称、启用状态、Base URL、API 格式、API Key。
- API 格式下拉只展示当前供应商 endpoint 和模型 metadata 共同支持的格式；纯自定义供应商仍可从系统支持的格式全集里选择。
- 模型列表默认只展示紧凑模型行；模型 ID 保持行内编辑，模型行右侧的编辑按钮打开弹窗编辑运行态 metadata。模型 ID 内的视觉能力与上下文窗口容量标签使用相同的细边框圆形 pill 尺寸、间距和字号；容量值使用 UI 字体并启用等宽数字，不切换成整段等宽字体。
- 模型列表始终展示全量模型。模型 ID 右侧用固定三列 tag 展示支持的 API 格式，顺序为 Anthropic、OpenAI Compatible、OpenAI Responses；当前选中的 API 格式 tag 高亮，其它支持格式弱化，不支持的格式保留空列以保证多行纵向对齐。当前格式不可测试时连通性测试按钮保留显示但禁用，不阻止编辑、删除或维护其他格式的模型 metadata。
- 弹窗内编辑上下文窗口和模型 `reasoning` metadata JSON；该 JSON 必须符合 `ModelProviderReasoningSpec` schema，保存后会参与聊天页 thought level 生成。
- `displayName` 仍可由 catalog/store 保留并参与 runtime projection，但设置页不提供直接编辑入口；`maxOutputTokens` 在模型弹窗的“高级”区域中编辑。
- 添加和删除模型。

## Runtime Sync

设置页新增、编辑、禁用、启用、删除 provider 后，UI 会：

1. 保存 host 侧 provider 配置。
2. 通过 `workspace/updateProviderRegistry` 同步到已打开 workspace 的 agent。
3. 使用返回的 workspace state 刷新当前聊天页 `configOptions`。

聊天页模型下拉优先读取 agent 返回的 `settings.model.available/current`，因此仅更新本地 JSON 不足以让当前会话立即看到新 provider。runtime sync 保留 `workspaceIdentity` fallback 规则：身份隔离用 `workspaceIdentity?.trim() || workspacePath`，路径执行仍用 `workspacePath`。

## Reasoning Metadata

Catalog 中的 `reasoning.levels[level][kind]` 是 provider options patch。转换到 ZCode Protocol 时会把公开 kind `openai-compatible` 映射成运行时 provider options namespace `openaiCompatible`，并生成聊天页可选 thought level。

没有明确 levels/patch 的模型不会伪造 reasoning 选项；聊天页只展示 agent registry 实际声明的可选值。
