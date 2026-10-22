# Bot 远端项目 runtime 路由

物理连接唯一 owner 是窗口 Host 的 SourceManager / URL Registry。router 只查已保留 host，显式重连复用 connectHost，不读旧 settings 连接记录、不创建 logical session 或第二条 runtime MessagePort。Server 的自有 Bot 直接使用本地服务。

目录 admission 复用连接提供的 canonical alias 端口；异步返回前后检查 membershipId 与物理 owner。同 cwd 不同 identity 严格隔离，移除 host 不会被旧请求恢复。命令继续走注入的原 task service / Controller owner 路由。

每个 Bot 消费者持有自己的动态订阅句柄。换代只订阅新 Source 的未来事件，固定 bot-channel-continuous，无 replay/snapshot 拼接；关闭或换代丢弃旧连接迟到事件。无轮询 timer、状态镜像、接受输入队列或连接缓存。设置仍是 app runtime preferences 的来源，主动同步仅枚举 Bot Repo 已固化的目标。

桌面 desktop-continuous 与手机 web-remote-replayable 原 attachment 语义均不改变。移除旧 main Bot 消息分支不移除 TaskRealtimeBus owner、lease、CommandInbox 或远端 canonical alias。
