# Task Snapshot 按需加载（首期）

## 背景

手机远程控制首次打开历史任务时，`getTaskSnapshot` 之前会返回整份 `messages`，在历史较长时会带来明显首屏等待（传输、JSON 解析、渲染均受影响）。

## 本次改动

- `IZCodeTaskService.getTaskSnapshot` 支持可选参数：`messageLimit?: number`
- 服务端在 ZCode task snapshot 组装时对 `messages` 做尾部裁剪：
  - 不传 `messageLimit`：保持现有全量行为
  - `messageLimit <= 0`：返回空消息数组
  - `messageLimit > 0`：返回最近 `messageLimit` 条消息

## 客户端启用策略（首期）

- 仅 Web 远程控制场景启用：`messageLimit = 100`
- 桌面端与非远控场景默认不传该参数，行为不变

## 兼容性

- 新参数为可选字段，不影响现有调用方
- 旧调用方无需修改即可继续工作

## 后续建议

- 为历史消息增加分页接口（cursor/beforeId）
- UI 聊天列表增加“加载更早消息”入口
- 逐步将桌面端切换到按需加载（灰度）
