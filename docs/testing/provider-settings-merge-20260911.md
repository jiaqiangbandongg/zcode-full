# Provider 稳定性分支合并记录（2026-09-11）

## 范围

- 用户要求重命名当前分支，并合入 `codex/provider-settings-todos`。
- 原分支：`codex/provider-schema-refinement-20260910`，基线 `cd81a0fc08`。
- 新分支：`codex/provider-stabilization-20260911`；解除对旧远端分支的 tracking，避免后续误推旧分支。尚未推送新分支。
- 合入本地目标分支固定提交 `9469388004`；fetch 后没有同名远端分支，目标位于另一个工作区，不修改其工作区或分支。
- 双方独有提交数 14 / 77。目标包含 staging 至 `7a01923f58` 的更新，不只是 Todo 文档。
- 正常双亲 merge，无显式冲突；不使用整文件 ours/theirs，不重做上游独立功能。

## 交集复核

- 自动合并交集为 `model-execution.ts` 和中英文 locale 文件。
- 请求安全校验：保留本分支两个官方套餐 URL 的手动 Key 安全校验准入，同时接入目标分支的安全校验观测、feature gate 日志与 attempt 观测链路。官方 URL 规则仍走原有安全校验，不被 access-mode 的未校验观测分支抢先截走。
- API Key 入口：保留单一 `apiKeyManagementUrl`，未恢复团队专用字段和双按钮文案；旧字段仅保留于拒绝该字段的测试断言。
- 设置布局：保留目标分支整页滚动和反馈定位改动，不恢复已删除的 ScrollEdgeShadowViewport；本分支卡片和 API Key 入口改动保持。
- 双方所有 Todo 按文件完整保留，不根据编号自动覆盖或将待办当成已实现。

## 验证

- 根目录 `pnpm typecheck`：通过。
- Adapter `pnpm typecheck`：首次因 Contracts 旧 dist 缺少新增安全校验观测类型失败；重建当前 Contracts 后通过，无源码修补。
- `pnpm lint`：0 errors、41 warnings；未借合并扩修无关告警。
- `pnpm architecture:check --changed`：合并前后均通过，0 new violations。
- 根目录 Provider／模板／安全校验共享代码／链接及布局定向测试：7 文件、87 项通过。
- Agent 独立测试入口的 manual-coding-plan-signing：18 项通过；不能用根目录测试命令替代，该目录未被根配置纳入。
- 模型行编辑、模板选择、API Key 链接组件测试：3 文件、55 项通过（链接测试与前批有重合，不累计成独立用例总数）。
- 未进行 Pro／Air 实机、手机远控或全产品 E2E，不将本次合并检查等同于相关 Todo 的完整验收。
- `git diff --cached --check` 指出目标分支已有的两份 Document Skills 文件末尾空行及决策模板的三处行尾空格；这些内容来自固定目标，不为合并单独修改上游插件内容。

## 保留事项

合并时两边 Todo115～Todo122 编号重复。现按用户要求保留原分支编号，将合入分支的八项顺延为 Todo125～Todo132，文件名、标题、目录和交叉引用已同步更新：

| 合入分支原编号 | 当前编号 | 主题 |
| --- | --- | --- |
| Todo115 | Todo125 | 模型设置页问号说明与定稿文案 |
| Todo116 | Todo126 | GLM-5.3-Flash PDF 与 Coding Plan API Turbo 默认配置 |
| Todo117 | Todo127 | Built-in 配置在线发布与更新链路修复 |
| Todo118 | Todo128 | Provider 启动契约与闲时资格刷新修复 |
| Todo119 | Todo129 | Provider 埋点适配与 Team 套餐识别修复 |
| Todo120 | Todo130 | 智能配置开关与手动配置字段边界修正 |
| Todo121 | Todo131 | 模型设置页智能配置位置与“恢复”按钮 |
| Todo122 | Todo132 | 模型选项底色反馈与供应商名称编辑修复 |

原分支 Todo115～Todo124 不变。此次仅整理文档身份，不改需求或实施状态；文档中的 M120／R121／T119 等已有用例追踪 ID 保持稳定，不随 Todo 编号重排。

本记录不承诺修复已记录的 Provider、迁移、Subagent、容量或连接测试问题，也不实施目标分支新增的待办。
