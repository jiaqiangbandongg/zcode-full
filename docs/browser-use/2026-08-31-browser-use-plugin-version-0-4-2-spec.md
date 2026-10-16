# Browser Use 插件 0.4.2 版本同步规格

> 日期：2026-08-31
> 状态：已实现并验证
> 关联改动：让 `node_repl` 的业务失败通过标准 MCP `isError` 语义暴露给下游分析。

## 1. 版本决策

本次改动改变了 Browser Use MCP runtime 的失败结果形态。失败结果不再使用
`message-only` 隐藏标准错误标记，因此按 patch 版本发布为 `0.4.2`，避免官方插件缓存、
Desktop 内置资产或 SEA 产物继续以 `0.4.1` 身份提供新行为。

## 2. 版本事实源

以下五处必须保持完全一致：

1. `apps/zcode-cli/packages/browser-use-plugin/package.json`；
2. `apps/zcode-cli/packages/browser-use-plugin/.zcode-plugin/plugin.json`；
3. Bootstrap `OFFICIAL_PLUGIN_DEFINITIONS`；
4. SEA `officialSeaPlugins`；
5. MCP `NODE_REPL_SERVER_VERSION`。

版本测试必须同时校验 package、manifest、Bootstrap definition、SEA manifest 和 serverInfo，
并覆盖官方 cache 路径，防止源码版本、安装版本和发布产物再次分叉。

## 3. 发布与缓存链路

```text
package / manifest / Bootstrap / SEA / serverInfo = 0.4.2
                         |
                         v
 filesystem / SEA / Desktop / remote official assets
                         |
                         v
 seed temp -> atomic promote -> browser-use/0.4.2
                         |
                         v
 标准 MCP 失败标记与对应 runtime 一起生效
```

## 4. 兼容边界

- 不修改 `ToolResultPayload` 等现有协议，不新增 `resultStatus`。
- `0.4.1` 可以作为历史缓存保留；官方 discovery 只应指向 `0.4.2`。
- 历史 changelog 和 `0.4.1` 规格继续记录旧版本事实，不回写为新版本。

## 5. 验证

- Browser Use plugin、Bootstrap cache、SEA 版本对齐测试通过。
- 根仓库 `pnpm typecheck`、`pnpm lint` 通过。
