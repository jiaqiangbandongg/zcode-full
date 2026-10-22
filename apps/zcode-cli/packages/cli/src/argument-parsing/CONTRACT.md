# CLI 参数解析

登记既有 `arguments.ts` 的参数解析边界。保留原导入路径，契约目录只描述接口，不创建另一套解析器。

- `parseGlobalArgs` 严格解析全局选项，未知选项仍报错；模式值的业务校验继续由调用方负责。
- `extractDisallowedToolsArgs` 提取并规范化工具禁用规则，返回剩余参数，不修改调用方数组。
- `isProtocolServerInvocation` 只判断协议服务入口，不启动进程，也不修改配置。
- 本模块不持有 session、provider 或工具注册状态，不改变 prompt、TUI、resume 的启动策略。

策略精确覆盖 `arguments.ts`、本契约目录和契约测试目录；CLI 其他入口仍保持原有归属。
