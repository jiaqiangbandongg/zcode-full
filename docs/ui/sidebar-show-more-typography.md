# 侧栏“显示更多”文字

2026-09-15：项目侧栏的分页入口与任务标题、空态“暂无任务”使用相同的 `text-ui-base` 字号，随界面字号设置缩放。默认文字颜色与空态一致，使用 `text-foreground-subtlest`；hover 和键盘 focus-visible 时使用 `text-foreground`，背景保持透明。

由现有 `ProjectTaskRows` 渲染入口，保留文字缩进和分页点击行为；普通列表每次增加 5 条，置顶列表沿用原展开/收起。只调整展示 token，不新增状态、IO、协议或迁移。桌面与手机 Web 共用此组件及主题 token，continuous/replayable 传输边界不变。

## 验收

`VP-MORE-01`（accepted/pending）：隔离 HOME 的真实 Electron renderer 准备 6 条任务及空项目，比较入口、任务标题与“暂无任务”的 computed font-size，比较入口与空态的默认颜色；明暗主题、1200/390px、14/18px 界面字号均保持一致。真实鼠标 hover、键盘 focus-visible 有提亮反馈，点击从 5 条展开到 6 条并隐藏入口。保存截图和样式采样，不请求 provider；窄屏模拟不代表手机 shared-host 或 Windows/Linux 实机验证。

## 验证结果

修复前 Electron 实测入口 12px、标题和空态 14px，默认颜色也不一致；用例在字号断言失败。修复后 `desktop-e2e-20260915123224650-p53861-1395a2f25af8019d` 1/1 通过，8 组 computed style、hover/focus、5→6 分页均通过，截图与 `show-more-styles.json` 留存在该运行目录。保持 pending。

`typecheck`、`typecheck:e2e`、格式检查通过；lint 为 47 个既有 warnings、0 errors。HEAD 增量架构检查 0 违规；默认分支检查仍有既有 `root/resolveConversationWorkspaceTarget.ts` unmanaged-new-file，非本次引入。
