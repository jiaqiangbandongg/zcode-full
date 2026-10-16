# 本地工作区路径与冷恢复身份边界

## 状态

- 类型：Bug 修复规格
- 影响面：桌面端本地工作区、CLI session 持久化、V4 conversation 冷恢复
- 不改变：远程 workspace identity、桌面 `desktop-continuous` 与手机 `web-remote-replayable` 的投递语义

## 问题

本地工作区允许不传 `workspaceIdentity`，身份 key 按既有规则取：

```text
workspaceKey = workspaceIdentity?.trim() || workspacePath
```

用户从目录选择器得到的 `workspacePath` 可能保留末尾 `/`。该值用于 provider registry、tab、task index 等工作区身份状态；CLI 创建运行时时又通过 `path.resolve` 得到不带末尾 `/` 的执行目录，并把执行目录写回 session 的 `path` / `directory`。CLI 重启后，V4 冷恢复只根据 session 中的路径重建工作区引用，于是同一个本地目录出现两个精确 key：

```text
当前 attachment / provider registry   /home/user/project/
session 冷恢复路径                    /home/user/project
```

这不是 provider catalog 查找阶段的问题，而是工作区身份信息在运行时与持久化边界被执行路径覆盖。

## 语义边界

`workspacePath` 与 `workingDirectory` 必须分开保存：

```text
目录选择器 / 当前 attachment
  workspacePath: /home/user/project/
             |
             +--> workspaceKey / provider registry / task index
             |
             +--> AgentRuntimeConfig.workspacePath
                        |
                        +--> session.path + session.directory（身份恢复）

执行链路
  workspacePath: /home/user/project/
             |
             +--> path.resolve(...)
                        |
                        +--> workingDirectory: /home/user/project（cwd / 文件 / Git）
```

- `workspacePath`：保留调用方传入的实际路径表示，用于本地 workspace 身份恢复。
- `workingDirectory`：可以规范化，只用于命令 cwd、文件读写和 Git 等执行语义。
- 不全局规范化 `workspaceKey`，避免迁移或拆断现有 tab、task index、provider registry 等持久化 key。

## V4 冷恢复

conversation subscribe 已位于一个可信 workspace attachment 中，必须把当前 `workspace` 引用传给冷恢复：

```text
desktop / web attachment
  -> v4/conversation/subscribe { sessionId, workspace }
  -> ColdSessionResumeCoordinator
  -> activateSessionForResume({ sessionId, workspace })
  -> provider registry 按当前 workspaceKey 命中
```

优先级：

1. 当前 subscribe 携带的 `workspace`；
2. 仅当调用方没有 workspace 上下文时，回退到已持久化 session 的 `path` / `directory`。

这样既能修复新建 session 的持久化信息，也能立即恢复旧版本已经写入无末尾 `/` 路径的历史 session。

## 验收场景

1. 本地工作区路径带末尾 `/` 时，新 session 持久化保留该路径，运行时 cwd 仍为规范化路径。
2. 历史 session 记录为无末尾 `/`，当前 attachment 为带末尾 `/` 时，冷恢复使用 attachment workspace，provider model 可用并可继续发消息。
3. 没有当前 workspace 上下文的兼容调用仍可从 session 持久化路径恢复。
4. 远程 workspace 继续完整携带 `workspaceIdentity` 与 `remoteSessionId`，不按 `workspacePath` 单独隔离。
5. 桌面 continuous 与手机 replayable 只共享 workspace 引用透传，不改变 snapshot、gap、queue 或消息投递边界。
