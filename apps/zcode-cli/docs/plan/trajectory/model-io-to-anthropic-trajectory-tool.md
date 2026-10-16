# Model-IO 到 Anthropic Messages Trajectory 转换工具

状态：完成

## 背景

`tools/prompt-trajectory derive` 当前只支持 prompt-trajectory 自己录制的 `trajectory.jsonl`。ZCode CLI 运行时还会在 `~/.zcode/cli/debug` 或 `~/.zcode/cli/rollout` 下输出真实 `model-io-*.jsonl`，其中 request body 可能按上一条 model-io 记录进行 delta 压缩，并包含 `session_title` 等 sidecar 请求。

为了审阅整段主会话最终发送给 provider 的 prompt，需要把一个完整 model-io session 转成单个 Anthropic Messages 格式的 request trajectory，而不是把每条 model-io request 分别导出。

## 目标

- 新增 prompt-trajectory 可复用命令，从 ZCode `model-io*.jsonl` 生成 Anthropic Messages 格式的 trajectory JSON。
- 默认只纳入 `querySource === "main_turn"` 的主会话请求，排除 `session_title` 等 sidecar。
- 转换前先按原始文件顺序展开 model-io delta，再过滤 querySource，避免 sidecar 插入导致主会话误判为非增量。
- 输出 `anthropic_trajectory.json`，用于直接审阅整段主会话最终 provider-visible messages。
- 同时复用现有 derive manifest/trajectories 输出，便于检查是否出现 `non-incremental-change` split。

## 非目标

- 不把 subagent、compact、web_search_tool 等 sidecar 默认合并进主会话 trajectory。
- 不新增 production runtime 依赖；该能力只属于 `@zcode/prompt-trajectory` 测试工具。
- 不改动 runtime model-io 记录格式。

## 命令契约

```bash
pnpm --filter @zcode/prompt-trajectory model-io -- \
  --input ~/.zcode/cli/debug/model-io-<session>.jsonl \
  --out tools/prompt-trajectory/out/<run>
```

默认行为：

- `--query-source` 省略时使用 `main_turn`。
- `--input` 必填。
- `--out` 必填。

输出：

- `anthropic_trajectory.json`：第一个派生 trajectory 的 Anthropic Messages request body。主会话无 split 时它就是完整单 trajectory。
- `manifest.json`：沿用现有 derive manifest。
- `trajectories/*.openai_request_body.json` 与 `trajectories/*.anthropic_request_body.json`：沿用现有 per-trajectory 调试产物。

## 验收

### 连续性判定（2026-09-12）

`non-incremental-change` 表示已记录内容发生非增量变化，不表示 runtime 取消或 provider
缓存未命中。连续性的唯一事实源是展开 delta 后的相邻请求；response 只补充该请求的回复。

```text
原始 model-io → 展开全部 delta → 按 querySource 过滤
                                      ↓
上一请求 + response 摘要 ← 下一请求中对应的完整 assistant
                                      ↓
连续性比较 → 完整 trajectory / 真实改写处分段
```

- model-io response 的 text/toolCalls 是有损摘要，不含 thinking block 的完整结构和签名。
  下一请求保留上一请求前缀，且紧接的 assistant 去除 thinking/redacted_thinking 后与
  摘要全文一致时，使用该真实 assistant 补全上一回复，原样保留 thinking 和签名。
  不从 reasoningText 编造 provider block 或签名；没有后续请求时沿用已有摘要导出。
- 仅允许上一序列末尾的 user 在原 content block 完整不变的前提下追加 block；其余
  message 属性必须一致。不得接受原 block 改写、删除、重排、角色变化或非末尾消息扩展。
- 已经出现在真实请求中的 thinking、签名、正文、tool input/result 和 reminder 均参与
  严格比较。只在比较时忽略已有 cache_control 漂移，最终产物保留最新请求原值。
- 保留真实 compact 和历史改写的分段；不改变 runtime、provider 请求、缓存、权限、
  desktop continuous 或手机 replayable 行为。重新解析历史文件不请求模型、不写会话库。
- 回归覆盖完整 thinking/签名、redacted thinking、sidecar/delta、末尾 user 追加与负例；
  真实样本重新导出后逐条比较最新请求和所有已插入 reminder。

- 能读取真实 ZCode model-io JSONL。
- 能正确展开 `bodyMessagesKind: "delta"` / `bodyMessageOffset` 压缩。
- `session_title` 请求不会进入默认主 trajectory。
- main_turn 里 append-only 的 full 续接不会被误判为 `non-incremental-change`。
- 单测覆盖 delta 展开、sidecar 过滤、Anthropic Messages 输出文件。

验证命令：

```bash
pnpm --filter @zcode/prompt-trajectory exec node --import tsx --test 'tests/*.test.ts'
pnpm --filter @zcode/prompt-trajectory typecheck
pnpm --filter @zcode/prompt-trajectory exec oxlint --no-ignore src tests scripts
```
