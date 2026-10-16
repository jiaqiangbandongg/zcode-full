# Browser Use Plugin 0.3.0 版本与录屏资产同步规格

> 日期：2026-08-14
> 状态：已实现并验证
> 关联能力：`capability.browser-use-plugin-distribution`、`capability.browser-webview-video-recording`

## 1. 目标

Browser Use 新增 IAB WebView 录屏 API 后，将官方插件发布身份从 `0.2.1` 升级到 `0.3.0`。
录屏协议、Browser client、模型文档和 MCP serverInfo 属于同一发布单元，禁止 package、manifest、
官方 seed、SEA 与 MCP runtime 各自暴露不同版本。

以下五个当前版本事实源必须统一为 `0.3.0`：

1. `apps/zcode-cli/packages/browser-use-plugin/package.json`；
2. `apps/zcode-cli/packages/browser-use-plugin/.zcode-plugin/plugin.json`；
3. Bootstrap `OFFICIAL_PLUGIN_DEFINITIONS`；
4. SEA `officialSeaPlugins`；
5. MCP `NODE_REPL_SERVER_VERSION`。

根应用版本、其他私有 workspace package 版本和 lockfile 不属于本次插件版本边界。

## 2. 发布与缓存链路

```text
package / manifest / Bootstrap / SEA / serverInfo = 0.3.0
                         |
                         v
 filesystem / SEA / Desktop / remote official assets
                         |
                         v
 seed temp -> atomic promote -> browser-use/0.3.0
                         |
                         v
 marketplace partition 只指向 0.3.0
```

`0.2.1` 可以作为 stale cache 与 `0.3.0` 并存，但 discovery 只能加载 official partition 指向的
`0.3.0`，不得产生 duplicate diagnostic，也不得复用旧版 seed marker。

## 3. 录屏文档资产合同

`docs/documents.json` 通过 lookup name `recording` 暴露 `docs/recording.md`。因此
`docs/recording.md` 必须加入以下完整性检查，而不只是依赖目录递归复制：

- Bootstrap `OFFICIAL_BROWSER_USE_REQUIRED_SEED_PATHS`；
- SEA `browserUseRequiredRuntimePaths`；
- Desktop `prepare-agent-node-bundle.mjs`；
- remote `prepare-prebuilds.mjs`；
- Server `REMOTE_AGENT_OFFICIAL_PLUGIN_REQUIRED_RELATIVE_PATHS`。

缺失录屏文档时，filesystem seed、SEA 构建或 remote 资产复用检查必须失败，不能生成“API 已注册但
lookup 文档不存在”的残缺官方插件。

## 4. Case Planning

| Case ID | Setup | Action | Assertions | Evidence |
| --- | --- | --- | --- | --- |
| BUV-030 | 五个版本事实源 | 运行版本对齐测试 | 全部精确等于 `0.3.0` | Bootstrap、SEA、MCP unit |
| BUV-031 | `0.2.1` 与 `0.3.0` cache 并存 | discover plugins | 只加载 `0.3.0`，无 duplicate diagnostic | Adapter unit |
| BUV-032 | Browser Use source 缺少 `docs/recording.md` | filesystem/SEA seed | 完整性检查拒绝残缺资产 | Bootstrap、SEA unit |
| BUV-033 | Desktop/remote runtime 资产脚本 | 检查必需路径合同 | `docs/recording.md` 在本地和远端链路均存在 | Desktop、Server unit |

## 5. 完成门槛

- 五个版本事实源与显式版本断言统一为 `0.3.0`；
- current cache fixture 使用 `0.2.1` 作为 stale、`0.3.0` 作为 current；
- 五条发布资产链都把 `docs/recording.md` 作为必需项；
- Browser Use、Bootstrap、Adapter、SEA、Desktop、Server 定向测试通过；
- `pnpm typecheck`、`pnpm lint` 通过。

## 6. 验证结果

| 验证项 | 结果 |
| --- | --- |
| Browser Use plugin | 6 files / 32 tests 通过 |
| Bootstrap plugin distribution | 2 files / 41 tests 通过 |
| Adapter stale/current cache | 1 file / 66 tests 通过 |
| SEA Browser Use release/alignment | 2 tests 通过 |
| Desktop + Server runtime assets | 2 files / 116 tests 通过 |
| `pnpm typecheck` | 通过 |
| `pnpm lint` | 0 errors；仓库已有 warnings 保持不变 |
