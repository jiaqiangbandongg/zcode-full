# CUA Dev node_repl SDK Runtime 资产闭环

## 目标

CUA 不再有独立 MCP launcher。桌面 Dev 只需播种 CUA SDK、Skill 和按需 docs，复用
Browser Use 与 Computer Use 共用的 shared `node_repl` MCP（只有 `js` 一个工具）。
原生 Helper、frame registry、kill switch、input hold 和 `possibly_sent` 仍由 shared-host
`CuaControlPort` 持有；手机端只能 attachment 到已有 host。

```text
pnpm dev:desktop
  |
  +-- stage Browser node_repl runtime (the only MCP server)
  +-- stage zcode-cua SDK/docs/skill (no mcpServers entry)
  `-- build Agent bundle and filesystem seed
          |
          v
      node_repl MCP (3 model tools)
          |
          `-- Worker bootstrap -> agent.computerUse -> local bridge
                              -> CuaControlPort -> BrokerClient -> Helper
```

没有 broker/权限时 SDK 返回明确 unavailable；不会在 relay、手机端或每个 session 另起
Helper/CUA runtime。桌面使用 `desktop-continuous`，手机使用 `web-remote-replayable`。

## 资产与状态边界

| 事实 | 权威 owner | 产物/校验 |
| --- | --- | --- |
| CUA SDK | `@zcode/zcode-cua-plugin` | `scripts/computer-use-client.mjs` + `scripts/check-sdk.mjs` |
| CUA 文档与 Skill | producer plugin | `docs/computer-use.md`、`skills/computer-use/SKILL.md` |
| node_repl MCP | `@zcode/browser-use-plugin` | `dist/mcp/server.js` + `scripts/computer-use-client.mjs`（shared host runtime） |
| CUA runtime/session/frame | shared-host `CuaControlPort` | `createComputerUseRuntime()`；按 `workspaceKey`/`remoteSessionId`/`sessionId` 隔离 |
| native capability | CUA Helper + TCC | broker token、frame freshness、kill switch、input cleanup |

## 必须保持的约束

- 新会话的模型工具投影只有 `mcp__node_repl__js`；旧 `mcp__computer-use__*` 配置和已删除的
  `js_reset` / `js_add_node_module_dir` 在 bootstrap 中丢弃，历史 transcript 仅只读回放。
- 每次 `js` Worker 都重新 bootstrap SDK，但不会销毁 shared-host CUA runtime 或 frame state。
- node_repl bridge 请求必须带 `workspaceIdentity`、`workspacePath`、`workspaceKey`、
  `sessionId`、`remoteSessionId`、`turnId`、`traceId`、`clientMode`、`deliveryKind`；subagent
  在 bridge 入口 fail closed。
- broker 凭据只注入可信 shared node_repl；plugin host 不再接受旧的 CUA argv socket 入口。

## 验收用例

| Case | 验证 |
| --- | --- |
| SDK 30 方法契约 | producer manifest/schema 与 SDK 方法 union 一一对应 |
| Worker 重建 | 多次 `node_repl js` 调用可重新 bootstrap，CUA runtime/session 状态保持 |
| 图片结果 | SDK 将 CUA image block 送入通用 `nodeRepl.emitImage`，不把 base64 变成文本 |
| 无 broker/权限 | 返回 unavailable/permission error，不启动独立 MCP/Helper |
| 远程边界 | desktop continuous 与 web remote replayable 共享 attachment，不把 CUA 状态放进 relay/snapshot |
| 历史记录 | 旧 `mcp__computer-use__*` 可查看但不能重新执行或重新注入 |

## 相关实现

- `apps/zcode-cli/packages/browser-use-plugin/src/cua-bridge.ts`
- `apps/zcode-cli/packages/browser-use-plugin/src/mcp/cua-broker.ts`
- `apps/zcode-cli/packages/browser-use-plugin/src/mcp/server.ts`
- `apps/zcode-cli/packages/zcode-cua-plugin/scripts/computer-use-client.mjs`
- `apps/zcode-cli/packages/bootstrap/src/app/built-in-node-repl.ts`
- `docs/cua/2026-08-24-cua-node-repl-sdk-migration-spec.md`
