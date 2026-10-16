# Sidebar Task Timeline Groups

Sidebar 的 timeline 视图按当前排序字段做时间分组：

- `updatedAt`：排序方式为更新时间时使用。
- `createdAt`：排序方式为创建时间时使用。

分组顺序从具体到粗粒度：

1. 今天
2. 昨天
3. 2 天前 / 3 天前
4. 本周
5. 上周
6. 本月
7. 上月
8. 更早

周分组按当前 UI 语言决定自然周起点：英文为周日，中文为周一。分组逻辑只在 UI 层使用，service 仍只提供任务时间戳，避免把展示文案或 locale 规则下沉到任务数据层。
