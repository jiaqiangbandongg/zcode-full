# SSH 远端 Workspace 状态权威边界

> 当前事实文档。旧的 Desktop Provider Registry 快照下发方案已经退出；历史方案与事故轨迹只在
> working-memory、旧 plan/spec 和事故复盘中保留。

## 核心结论

Desktop-attached SSH/Docker/WSL 只描述一种连接和操作关系，不表示 Desktop Environment 延伸到远端。
执行 Agent 所属的 Remote Environment 拥有 Provider Config、账号事实、Credential Store、Registry 和
ModelFactory。

```text
Desktop Environment                     Remote Environment
===================                     ==================
Desktop app-global settings             Remote ZCode Built-in Config
Desktop OAuth / UI state                Remote Personal Provider Config
Local Provider Runtime                  Remote Account Provider Config
Local Registry                          Remote Credential Store
                                        Remote Registry
        |                                     |
        | remote settings/selection/task RPC  |
        +------------------------------------>|
                                              v
                                      Remote ModelFactory
                                              |
                                              v
                                      Remote model request
```

Desktop 不向 Remote Worker 注入以下内容：

- 完整 Provider Registry 或其序列化快照；
- Runtime Model 或 Provider/Model 静态配置快照；
- Desktop Account Provider Config；
- Desktop API Key、JWT、Team Runtime Key 或动态请求 Header。

旧 `workspace/updateProviderRegistry`、`ZCodeProviderRegistrySnapshot` 和
`remoteWorkspaceProviderSync` 不再属于生产协议或运行链路。

## 状态归属

| 状态                                   | 权威位置                | Desktop-attached remote 的读取方式        |
| -------------------------------------- | ----------------------- | ----------------------------------------- |
| Workspace 文件、Git、Terminal          | Remote Environment      | 远端 Service                              |
| Task、Session、Agent execution         | Remote Environment      | 远端 Service                              |
| Provider Settings View（远程 runtime） | Remote Environment      | 远端 `provider-settings` Facade           |
| Desktop 模型配置页（app-global）       | Desktop Environment     | 本地 `IProviderSettingsService`           |
| Model Selection View（远程 runtime）   | Remote Environment      | 远端 `model-selection` Facade             |
| Provider Config / Registry             | Remote Environment      | 不跨 Environment 传输 Registry 对象或快照 |
| Provider Credential / Request Auth     | Remote Environment      | 不从 Desktop Credential Store 注入        |
| Desktop 主题、窗口和本地 UI 状态       | Desktop Environment     | 本地 Service                              |
| Desktop continuous / Mobile replayable | 各自既有 delivery owner | 不受 Provider 边界改变                    |

Renderer 面对的 remote workspace ServiceCollection 可以混合本地 UI Service 与远端业务 Service，但
混合只是 Facade 装配方式，不改变上表的事实所有权。远程 workspace 的 runtime、Session、模型执行
仍必须使用目标 Environment 的 Provider Settings 和 Model Selection；Desktop 设置页的 app-global
模型配置编辑是明确例外，只读写 Desktop Local Environment，不把编辑动作隐式路由到远端。

## Environment 内部同步

同一个 Environment 的 Host 与 Core Worker 各自持有 Registry 实例，并共享该 Environment 的配置事实：

```text
Environment Provider Sources
├─ ZCode Built-in Config
├─ Personal Provider Config
└─ Account Provider Config
          |
          +-------------------+
          |                   |
          v                   v
     Host Registry       Worker Registry
          |                   |
     Settings/View       ModelFactory/Execution
```

Host 可以通过 `provider/updateAccountConfig` 把本 Environment 的无 Secret Account Overlay 发送给自己的
Core Worker。该协议只承载 `revision + basedOnZCodeBuiltinRevision + ProviderConfigMap`，不承载 API Key、
JWT 或动态 Header。它是进程间一致性机制，不是 Desktop-to-remote Provider 同步。

Host 与 Worker 的 Registry 都由 Source 变化后自行重建；Registry View 不跨进程共享。已经创建的 Active
Model 保持创建时冻结的事实，新 View 只影响后续创建的 Model。

## 启动与恢复

```text
Remote Host 启动
      |
      v
读取 Remote Built-in / Personal / Account Sources
      |
      v
Remote Host Registry ready
      |
      +--> 暴露 Provider Settings / Model Selection
      |
      v
Remote Worker 启动并读取同一 Environment 的 Sources
      |
      v
Remote Worker Registry ready -> 创建 Session / Model
```

远端 Provider Runtime 未就绪时，调用方等待目标 Environment 自己的 ready barrier。不得以 Desktop Registry
快照作为 bootstrap、fallback 或重试材料。远端重连和 Worker 换代只重建远端自己的 Runtime，不触发本地
Registry 重放。

连接断开时，RPC 客户端仍必须 reject 所有 pending 请求并清理旧 generation；这是通用 transport 生命周期
不变量，与已退出的 Provider 同步功能无关。

## 配置与凭据 Provisioning

把配置或凭据复制到另一 Environment 是独立 Provisioning 产品能力，不属于 remote workspace runtime
attachment；当前实现与范围见 `docs/remote/provider-provisioning.md`：

```text
Source Environment Config / Credential
                 |
                 | explicit provisioning
                 v
Target Environment Config / Credential Store
                 |
                 v
Target Sources publish change
                 |
                 v
Target Registry rebuilds itself
```

Provisioning 必须先写入目标 Environment 的正式 Store，再由目标 Registry 重建。它不能直接构造 Registry、
Model、Runtime Header，也不能成为每次模型请求的在线依赖。远端设置编辑和远端登录同样应调用目标
Environment 的正式 Service，而不是把 Desktop Credential Store 当成远端鉴权源。当前同步是显式
Local → Remote；本地登出或删除不会撤销已经写入远端的凭据。

## 不变量

- `workspaceIdentity` 表示身份隔离，`workspacePath` 只用于文件和命令执行。
- Desktop remote attachment 不创建第二份 Agent Runtime 或第二份 accepted-input queue。
- Desktop `desktop-continuous` 不拼接手机 replayable 恢复消息；手机
  `web-remote-replayable` 不绕过 gap/snapshot 恢复。
- Provider/Model 静态事实只来自目标 Environment 的 Config 和 Registry。
- 动态请求凭据不进入 Account Provider Config、Registry View 或 Session 持久化。
- 已退出的完整 Registry writer 不提供兼容 fallback。

## 相关当前设计

- `docs/working-memory/provider-refactor/design/environment/environment.md`
- `docs/working-memory/provider-refactor/design/registry/runtime.md`
- `docs/working-memory/provider-refactor/design/registry/configuration.md`
- `docs/remote/zcode-agent-remote-deployment.md`
- `docs/web-remote-control/web-remote-control-architecture.md`
