# Visualize 技能的 CLI 加载边界

## 行为

内置 `visualize@zcode-plugins-official` 提供对话内交互视图，普通终端没有对应宿主。
非 `--stdio` 入口（TUI、`-p` / `--prompt` / `--target`、`skills list/inspect`）默认不注入
该插件的技能根，模型可用技能目录和 Skill 正文加载使用同一份发现结果。
即使 `-p` 使用 `--surface desktop` 模拟呈现面，也不自动启用该技能。

`--stdio` 协议入口在创建 App 和扫描草稿技能目录时显式传入 `includeVisualize: true`。
这是 bootstrap 内部装配选项，不是用户配置、环境变量或协议请求字段；缺省为关闭。
它与 Desktop context 的 presentation surface 灰度独立，保留既有协议端加载行为。
用户禁用插件、禁用技能或卸载内置插件后仍然不可加载，不允许该选项覆盖用户配置。

## 单一发现链路

```text
普通 CLI ── includeVisualize 缺省 ──┐
                                    ├─ 官方插件技能根过滤 → 技能发现 / Skill 加载
协议宿主 ─ includeVisualize=true ───┘                       ├─ 主会话目录
                                                           └─ workflow child 继承
协议草稿目录 ─ includeVisualize=true → 同一过滤规则 → 引用目录
```

只按官方插件 identity 过滤，保留其他插件和用户/项目自定义的同名技能。
插件市场目录、缓存 seed、安装记录和启停配置不变；`plugins list` 仍可管理该插件。
过滤在 App 启动解析插件技能根时完成，主会话与 workflow child 使用同一份结果；
普通 subagent 继续继承父会话技能端口。恢复会话同样按当前启动入口重新装配。

Desktop 本地和附着的 SSH/WSL/Docker workspace 继续走 stdio 协议；手机 `/remote`
复用同一个 shared host。此变更不改 workspace identity、owner/lease、队列、事件流、
snapshot 或恢复逻辑；桌面 continuous 与手机 replayable 边界保持不变。

## 验证

- 默认/显式关闭时，正式技能目录没有内置 visualize，按名称和限定名加载均报不存在。
- 协议启用时可发现并读取完整技能；用户禁用配置继续生效。
- 主会话启动和 workflow child 共享过滤后的根，其他内置技能保持可用。
- 协议 App 装配与草稿目录都保留 visualize；普通项目同名技能不受影响。
- 构建实际 CLI，验证非 stdio 的 list/inspect 和 stdio 的技能目录请求。
- 没有修改 Renderer 交互和协议 schema；用 CLI/协议集成验证加载边界，无新增 UI E2E。
