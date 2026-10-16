# Workspace Hook Trust 用户指南

Workspace/project Hook 来自仓库配置并可执行本地命令，因此默认未信任。打开 workspace、
启用普通 Hooks 总开关或确认 deep link 都不会自动授权。

## 在设置中信任

当自然事件命中未信任 Hook 时，对话照常继续，Hook 保持 fail closed。聊天区域会提示存在
待审核 Workspace Hook；点击后进入 `设置 → 钩子 → 工作区`。

未信任行只在最右侧配置开关左边显示“信任”：

```text
Hook 名称与命令                                      [信任] [开关]
```

- 点击“信任”建立当前 `workspaceIdentity + hookDeclarationDigest` 的持久 Trust；成功后按钮消失。
- 配置开关只控制 Hook 是否启用，不会建立或撤销 Trust。
- 页面不提供本次授权、批量信任或行内撤销。
- 关闭设置、超时、断连都等于“没有决定”，不会改变 Trust。

信任只影响之后自然发生的事件。已经因未信任而跳过的 SessionStart 不会在当前 task 的下一条
消息补跑；它最早在下一次真实的新 task/session SessionStart 运行。

声明的命令、matcher 等语义发生变化时 digest 会变化，新声明恢复未信任并重新显示按钮；
未变化声明继续命中原 Trust。

普通工具执行权限中的 `Allow once` 是另一套权限系统，不属于 Workspace Hook Trust。

## 安全与恢复

- managed `deny` 始终高于用户 Trust。
- rollout gate 关闭时所有 project Hook hard block，已有记录保留但不读取。
- stale task/run/remoteSession/generation/snapshot 响应在写 Trust store 前被拒绝。
- Desktop continuous 与 mobile replayable 使用同一 Runtime 权威审核绑定；重连不能扩大授权。

需要撤销已有记录时，使用受信任的管理/CLI 入口按 exact digest 撤销；配置开关不承担撤销语义。

### Trust store 损坏（`workspace_hooks_trust_store_corrupt`）

持久 Trust store（`~/.zcode/security/workspace-hook-trust-v1.json`，可被 user config 的
`storage.dir` 重定向）按完整 strict schema 解析：JSON 语法错误、缺少 `schemaVersion`、
record 缺少必需字段（`decision` / `grantedAt` / `digestAlgorithm` 等）、非法时间戳、未知
字段等一律判 corrupt 并 fail-closed——所有消费者（Settings UI、Runtime admission、CLI）
对同一文件得出同一结论，corrupt 下不展示任何 `trusted_persistent`，Hook 全部按未信任
软门禁跳过。

`zcode hooks trust status` 对损坏 store 显式返回
`reasonCode: workspace_hooks_trust_store_corrupt`（而非 `pending_trust`），且 `grant` /
`revoke` 会被拒绝直到修复。首次读取时损坏文件会被改名为
`workspace-hook-trust-v1.json.corrupt-<timestamp>`；恢复方式：从备份还原该文件，或确认
无需保留后删除 `*.corrupt-*` 残留文件以重建空 store，再重新执行 grant。

## 人工验收

仓库提供无害 fixture：

```bash
node scripts/create-workspace-hook-trust-uat-fixture.mjs
```

完整操作和预期结果见
[`workspace-hook-trust-manual-acceptance.md`](./testing/workspace-hook-trust-manual-acceptance.md)。
