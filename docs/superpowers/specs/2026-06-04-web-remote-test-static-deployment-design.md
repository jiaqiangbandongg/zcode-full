# Web Remote Test 静态资源部署设计

> 已归档：部署部分被 [Relay V2 收口任务](../../issues/web-remote-control-relay-v2/07-contract-v1-removal-and-docs.md) 取代。旧步骤及已迁走的基础设施引用已移除，不能作为当前发布操作手册。

历史设计的目标是将手机静态资源按路径隔离，防止新资源覆盖旧版本 App。当前 V2 以 OSS 版本目录实现该隔离，参见 [Remote v4 静态部署](../../web-remote-control/remote-v4-static-deployment.md)。

`/remote/__test__` 独立测试链继续保留；构建、镜像推送和路由验证以当前静态部署文档为准。应用层 relay 配对、workspace bridge 与任务恢复的最终行为见 [Relay V2](../../web-remote-control/relay-v2-pairing.md)。
