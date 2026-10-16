# Browser Use 插件 0.4.1 版本同步规格

> 日期：2026-08-26  
> 状态：已实现并验证  
> 关联改动：允许 `browser.evaluate` 执行页面副作用操作，并移除“禁止副作用代码”的过时描述。

## 1. 版本决策

本次改动改变了 Browser Use 的运行时行为和模型可见文档：`evaluate` 不再以只读模式执行，页面写入、提交和其他副作用由调用方自行负责。因此按 patch 版本发布为 `0.4.1`，避免已有官方插件缓存和 SEA 资产继续以 `0.4.0` 身份提供旧行为。

## 2. 版本事实源

以下五处必须保持完全一致：

1. `apps/zcode-cli/packages/browser-use-plugin/package.json`；
2. `apps/zcode-cli/packages/browser-use-plugin/.zcode-plugin/plugin.json`；
3. Bootstrap `OFFICIAL_PLUGIN_DEFINITIONS`；
4. SEA `officialSeaPlugins`；
5. MCP `NODE_REPL_SERVER_VERSION`。

测试同时覆盖官方 cache 路径和版本对齐断言，防止只修改 package 或只修改打包清单。

## 3. 发布与缓存链路

```text
package / manifest / Bootstrap / SEA / serverInfo = 0.4.1
                         |
                         v
 filesystem / SEA / Desktop / remote official assets
                         |
                         v
 seed temp -> atomic promote -> browser-use/0.4.1
                         |
                         v
 evaluate 页面副作用能力与最新文档一起生效
```

## 4. 兼容边界

- `evaluate` 允许页面副作用，但宿主仍保留统一的副作用审计和日志分类。
- 桌面端 continuous 链路与 Web 远程 replayable 链路不因版本升级改变交付语义。
- `0.4.0` 可以作为旧缓存保留；官方 discovery 只应指向 `0.4.1`。

## 5. 验证

- Browser Use plugin、Bootstrap、Adapter stale/current cache、SEA 版本对齐测试通过。
- 根仓库 `pnpm typecheck`、`pnpm lint` 已通过；lint 仅保留仓库既有 warnings。
