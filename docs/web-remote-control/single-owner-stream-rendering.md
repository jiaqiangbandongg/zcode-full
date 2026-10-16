# Single Owner Stream Rendering

> 状态：当前只描述 replayable 订阅下的非 owner 内容过滤。
>
> 桌面端 `continuous` 订阅仍消费 direct dynamic stream event，不走这里的空 batch
> 旁观端策略。手机 Web 远控 `replayable` 订阅才需要用这个策略降低断线恢复和 snapshot
> 对齐交错的风险。

## 背景

共享 host process 后，桌面端和手机端仍然是两个独立 renderer。手机浏览器可能长时间后台、断线或被系统丢弃，如果所有 renderer 都直接消费同一轮流式 chunk，断线恢复时容易和 snapshot 对齐交错，出现重复尾块或运行态分叉。

## 方案

每轮 prompt 由发送端 renderer 生成并传递 `clientId`。Host process 仍是唯一 ZCode runtime 和持久化事实源，`task_stream_mirror_batch` 会携带 `ownerClientId`。

Replayable 订阅按订阅端 `clientId` 过滤普通内容类 batch：

- `ownerClientId` 匹配的发送端收到完整流式 `ops`，负责实时渲染正文、tool、权限等细粒度状态。
- 其他 replayable renderer 可以过滤普通正文、thought、tool chunk，避免重复渲染。
- `permission_request`、`elicitation_request`、对应 response、`task_complete` / `task_error` 和 snapshot invalidation 不能被普通 owner-only 内容过滤吞掉；它们必须对同 task 在线客户端可见，或触发 snapshot 对齐。
- 最终消息、文件变更和任务元数据仍通过 `getTaskSnapshot()` 对齐。

## 稳定性边界

这能保证旁观端不再因为手机断线、重连或切任务重复消费中间 chunk。发送端如果是手机，手机 render 仍可能丢失实时画面，但 host process 会继续消费 provider stream 并落盘最终 snapshot。手机恢复后应以 snapshot 作为权威来源。

## UI 行为

Replayable 旁观端运行中可以不渲染流式正文，只显示“另一台设备正在发送消息...”的 loading 提示。任务结束后，snapshot 对齐会替换为最终消息块。桌面 continuous 端仍以 direct stream 保持实时正文渲染。
