# Issue tracker: Local Markdown

项目 Issue 使用本地 Markdown 文件。用户已明确要求不在远端仓库创建 Issue；只有后续明确要求线上发布时才改变该次操作的目标。Git remote 仅表示代码仓库位置，不能用它推断 Issue 发布位置。

## 文件与状态

- 已存在于 `docs/` 的完整 spec 可以直接作为本地 Issue，保留原路径，不复制第二份正文。
- 新的独立 Issue 放在 `docs/issues/<feature-slug>/<NN>-<slug>.md`，每个任务一个文件；同一功能从 `01` 顺序编号。已有 spec 的实现子任务链接到该 spec。
- 文件标题下使用 `Status:` 行记录状态。可直接实施的 spec 使用 `Status: ready-for-agent`，其余分诊状态沿用 `needs-triage`、`needs-info`、`ready-for-human`、`wontfix`；任务开始和完成时分别更新为 `in-progress`、`done`。
- 关联和依赖使用本地 Markdown 链接；讨论记录按需追加到文件末尾的 `## Comments`，无需将当前会话全文复制入库。

## 技能操作映射

- “publish to the issue tracker”：写入或更新本地 Issue 文件，应用对应 `Status:`，返回文件链接。
- “fetch the relevant ticket”：读取用户给出的文件或本地 Issue 编号对应的 Markdown。
- “apply ready-for-agent label”：写入 `Status: ready-for-agent`，不创建远端标签。
- Issue 工作流不调用 GitHub/GitLab 的创建或更新接口。MR 工作流继续遵守项目已有 MR 规则，两者相互独立。

## 当前 Issue

- [桌面本地消息 TTFT 分阶段遥测](../monitoring/ttft-stage-telemetry.md)
