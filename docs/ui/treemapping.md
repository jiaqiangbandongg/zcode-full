# Treemapping

Treemapping 是右侧 Side Pane 的当前轮 tool call 文件活动地图。它从当前 task 的 assistant message `toolCalls` 派生数据，不消费 Git Pane、Git status 或 Git diff。

## 数据与作用域

- Side Pane `+` 菜单打开当前轮 live map。
- Assistant message 赞/踩右侧的 Treemapping 按钮打开该轮 snapshot。
- v1 只看单轮；不跨轮累计。
- v1 对 `bash/shell/exec` 只消费结构化 `changes` / path / diff metadata，不从普通 stdout 或复杂命令字符串猜路径。

## 视觉规则

- 目录是中性嵌套框，只表达层级、聚合 diff 和目录 views；目录面积参考子树聚合 `diffCount`。
- 文件是叶子框：绿色新增、黄色修改、红色删除、蓝色仅查看。
- 文件大小主要来自 `diffCount = added + removed`。
- 无 diff 的变更使用最小变更权重，仅查看使用更小权重。
- 删除文件会保留红色历史叶子，即使真实文件已经不存在。

## 活动合并

同一文件在一轮里只显示一个框，事件流保留在详情区。状态优先级为：

1. deleted
2. created
3. modified
4. viewed

新建后修改仍显示绿色并累加 diff；查看后修改按变更色展示并保留 views。
