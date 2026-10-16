# 内置 Subagent 模型控件

Settings 为内置和插件 subagent 显示同一行内模型控件，但其他字段仍保持只读。

- `general-purpose` 默认继承父会话 main model。
- `Explore` 默认继承父会话 main model。
- 用户选择具体模型后写入 built-in model override。
- 清空覆盖后恢复内置默认行为。
- 思考等级与 Draft 都读取目标 Environment 的 Selection View；不再用 App metadata/catalog 双源回填。
- 加载失败与明确不可用分开；仅当前 ready 候选缺少原模型时提示“选择模型”，不清空持久意图。
- 内置 agent 不显示 edit、delete、enabled switch、prompt editor 或 tools editor。
- user subagent 继续沿用现有模型摘要展示。
- plugin subagent 的“继承默认”表示删除用户覆盖，回到插件 Markdown 的模型声明；没有声明才继承父模型。
  行内不重复显示模型徽标，行不可点击进入编辑，覆盖不写插件目录。

```text
目标 Environment Selection View
                  |
                  +--> ready --> 同一候选与档位来源
                  |
                  `--> loading / error --> 保留意图，区分加载与失败
```

主动选择新模型使用其最高档；历史缺档位不自动补齐。内置及插件覆盖一次写完整 ModelSelection，
保存失败回滚组合，保存成功后的刷新失败不回滚。完整合同见 `docs/subagents-built-in-model-overrides.md`。
