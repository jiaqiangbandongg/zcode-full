# Context Window Usage State（当前事实）

Context usage 的 conversation 事实源是 V4 `ConversationSnapshot.usage`，不是 renderer 的 legacy `taskRuntime`。

```text
CLI usage events -> ProductProjection.usage -> snapshot/delta
  -> SessionDataLayer -> composer toolbar / status UI
```

`V4ComposerToolbar` 读取 `snapshot.usage.contextWindow` 展示使用量。UI 不本地累加 token，也不从旧 task stream 拼 usage；恢复后以 snapshot 覆盖。

## compact 后冷恢复

Todo123：冷恢复按 `runtime.getSessionModelSelection() ?? record.restoredModelSelection`
的明确身份只读查询 Registry，不要求思考档位完整、不创建执行 Model，也不写回选择。
同一次历史加载取得一次容量，并把匹配的 usage seed 随加载结果交付投影；不另设缓存。
未知容量在内部 seed 的 maxTokens 中为 null，协议仍使用整个 contextWindow=null。
已用 token 保留；容量恢复后可以重新展示，不能回退 200,000。真实使用量事件和恢复期间
的新事件优先于旧种子；同模型 ModelSelected 可以更新上限但不重算用量。

```text
恢复身份 -> Registry 元数据（一次） -> 历史事件 + usage seed
                                           |
                                      补回 live 事件
                                           |
                      continuous / replayable 各自原有投递路径
```

冷恢复时 runtime projection 可能还没有 usage，首帧必须从 active-branch 持久消息恢复
最近一次水位，不能越过 compact summary 回退到压缩前的 assistant：

```text
active branch tail
  ├─ assistant       -> provider total / input + output
  └─ compact summary -> truePostCompactTokenCount ?? postCompactTokenCount
                                              |
                                              v
                                      cold snapshot usage
```

runtime `contextUsed > 0` 时仍优先使用 runtime；只有冷恢复 fallback 才倒序选择上述水位。
只有持久化 user compact summary 上带有效 token 的 boundary 才作为新水位；旧 assistant
boundary 或不完整历史继续沿用既有 assistant tokens fallback。boundary 水位不携带压缩前
请求的 cache，与热态 `CompactCompleted` 一致。

## Provider registry 热更新

设置页修改当前模型的 `contextWindow` 后，provider registry 应将新容量同时应用到已有
session 的 runtime 和 V4 conversation 投影。投影更新只替换
`snapshot.usage.contextWindow.maxTokens`，保留已有 `usedTokens`；不得等待下一次
`ModelComplete` 再校准。

当 registry 清除当前模型的显式 `contextWindow` 时，runtime 使用 `undefined` 表达未知容量，
`ModelSelected.contextWindow` 使用 `null` 表达“显式清除”。V4 conversation 投影收到
`null` 后必须将 `snapshot.usage.contextWindow` 清为 `null`；字段缺失只用于兼容旧事件，
不得解释为清除。容量未知期间，后续 `ModelComplete` 继续累计 token，但不得用
`maxTokens: 0` 重建窗口对象；投影内部保留最新 context 用量，以便容量恢复时重新发布。

```text
provider registry(contextWindow changed)
  -> active session runtime.updateConfig
  -> ModelSelected(same model + new contextWindow | null)
  -> ProductProjection.usage.contextWindow.maxTokens | null
  -> desktop-continuous / web-remote-replayable 各按原投递边界发布
```

这是同一模型的能力元数据热更新，不产生模型切换 marker，也不重算已使用 token。
