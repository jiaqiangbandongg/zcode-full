# SSH Config Alias Connection Plan

## 背景

当前 SSH dialog 只能让用户手动填写 `host / port / username / password / privateKeyPath`。
对于已经在 `~/.ssh/config` 里维护了多个 SSH alias 的用户，这条链路效率较低，也容易重复输入和填错。

目标是让用户在 SSH dialog 中直接选择本机 `~/.ssh/config` 里的 alias，并把 alias 对应的配置自动填充到现有表单中，再沿用现有远程连接流程继续连接。

## 目标

- 在 SSH dialog 的 SSH 配置区增加一个 alias 下拉菜单。
- 下拉菜单展示本机 SSH config 中可直接连接的 alias。
- 用户选择 alias 后，把可映射到当前表单的字段自动填入对应输入框。
- 自动填充后，用户仍可继续手动修改字段，再发起连接。
- 不破坏现有 `RemoteTarget`、远程历史记录、自动重连、desktop / web 兼容边界。

## 非目标

- v1 不做“直接把 alias 名传给后端，再完整按 OpenSSH 运行时语义执行”的能力。
- v1 不保证完整支持 `ProxyJump`、`ProxyCommand`、`Match exec`、`IdentityAgent` 等 OpenSSH 高级能力。
- v1 不从 SSH config 中读取或填充密码。
- v1 不把 alias 名本身作为远程历史记录和自动重连的持久化主键。

## 用户体验

### 交互位置

- 入口放在 SSH dialog 的第二步 `填写连接配置` 中。
- 仅当连接方式为 `SSH` 时显示。
- 下拉菜单放在 SSH 配置区顶部，位于 `Host / Port` 之前，语义上作为“快捷填表”入口。

### 交互行为

- SSH 表单首次展示时，懒加载本机 SSH config alias 列表。
- 如果成功读到 alias：
  - 显示一个可选下拉框，默认值为空。
  - 每个选项展示 alias 名，必要时补充摘要，例如 `user@host:port`。
- 如果没有读到 alias：
  - 下拉框可不展示，或展示 disabled 空状态提示。
- 用户选择某个 alias 后：
  - `HostName -> host`
  - `Port -> port`
  - `User -> username`
  - `IdentityFile -> privateKeyPath`
  - 若存在 `IdentityFile`，自动切换认证方式到 `Private Key`
- 自动填充后，用户仍然可以手动修改任意字段。
- 如果用户手动修改了 alias 已经填入的关键字段，清空当前 alias 选中状态，避免 UI 误导为“仍严格等于该 alias 配置”。

### 错误与降级

- 读取 SSH config 失败时，不阻塞用户继续手动填写表单。
- UI 只展示一条轻量提示，例如“SSH config 读取失败，仍可手动输入连接信息”。
- Web 端不读取本机 `~/.ssh/config`，统一返回空列表。

## 方案边界定义

本次能力定义为：

> 通过 SSH alias 快速预填现有 SSH 表单，再走现有 `connectRemote()` 链路完成连接。

这意味着：

- alias 只是“配置来源”，不是新的连接协议。
- 后端仍消费展开后的具体字段，而不是 alias 名。
- 如果某个 alias 依赖 OpenSSH 专有运行时能力，v1 只会提取其中可映射到现有表单的静态字段，不承诺完整复现命令行 `ssh alias` 的全部行为。

这个边界必须在实现和文档里保持一致，避免把“alias 自动填表”误做成“完整兼容 OpenSSH alias 直连”。

## 架构落点

### 分层原则

这项能力应该复用现有平台能力注入链路，不允许 UI 直接读本地文件：

```text
Desktop main / runtime
  -> preload
    -> IPlatformService
      -> useRemoteConnectionForm
        -> SSH dialog UI
```

原因：

- `~/.ssh/config` 是宿主机本地文件，只能由 desktop 平台层读取。
- UI 层只负责展示和表单状态，不负责访问本地文件系统。
- 这和当前 Docker / WSL 探测走 `IPlatformService` 的分层方式一致。
- Web 模式可以自然降级为空能力，不污染现有远程连接服务层。

### 不建议的做法

- 不要在 `packages/ui` 里直接读 `~/.ssh/config`
- 不要把 alias 解析逻辑塞进 React 组件
- 不要修改现有 `RemoteTarget`，把它变成 `alias | host`
- 不要让远程历史记录只保存 alias 名，否则 SSH config 变化后重连语义会漂移

## 数据模型

建议在 `packages/shared` 增加一个平台返回类型，例如：

```ts
export interface SSHConfigAliasOption {
  alias: string;
  host?: string;
  port?: number;
  username?: string;
  privateKeyPath?: string;
  source?: string;
}
```

说明：

- `alias`：展示名，也是选择值
- `host / port / username / privateKeyPath`：当前 UI 可直接消费的字段
- `source`：可选，表示命中的 config 文件路径，方便后续调试和日志

这个类型只表达“可用于表单预填的静态展开结果”，不试图承载完整 OpenSSH 配置全集。

## 平台接口设计

### Shared

在 `packages/shared/src/platform.ts` 的 `IPlatformService` 增加：

```ts
listSSHConfigAliases(): Promise<SSHConfigAliasOption[]>;
```

同时需要同步：

- `packages/shared/src/channels.ts`
- `packages/client/src/globals.d.ts`
- `packages/desktop/src/preload/index.ts`
- `packages/desktop/src/renderer/src/main.tsx`
- `packages/web/src/main.tsx`
- `packages/shared/src/web-remote-control.ts`
- 旧仓库内 relay 的平台代理文件（已移除，当前外部 relay 不承载该业务）
- `packages/desktop/src/main/webRemoteControlManager.ts`

### Desktop

在 desktop main 新增对应 IPC handler，仅负责转发与编排，不承载解析业务：

- 接收 renderer 的 `listSSHConfigAliases` 请求
- 转发到 host process / service 层执行 SSH config 读取与 alias 解析
- 返回适合 UI 预填的字段结果
- 异常时记录 `warn` 日志并返回 `[]`

同时明确职责边界：

- main 进程保持“调度层”，不内嵌 SSH config 解析逻辑
- 解析实现放在 host process / service，便于测试与复用
- 后续若扩展到 remote control 透传，也沿用同一 service 能力

### Web

- 普通 web 模式返回 `[]`
- Web remote control 模式可后续按需透传 desktop 机器的 alias 列表
- v1 如不做 web remote control 透传，也必须保持类型链路兼容，不能让接口只在 desktop 独有

## 解析策略

### 跨平台约束（必须满足）

该能力必须兼容 macOS / Linux / Windows，不能只按类 Unix 假设实现：

- SSH config 路径统一基于 `os.homedir()` 解析，再拼接 `.ssh/config`
- Windows 下优先走 `PATH` 里的 `ssh.exe`，并兼容系统 OpenSSH 常见位置探测
- 若运行环境不存在可执行 `ssh`，自动回退到内置轻量解析，不报阻断错误
- 路径与分隔符处理统一归一化，避免 `\` / `/` 差异导致解析失败

### 推荐策略

推荐采用“两段式解析”：

1. 扫描 `~/.ssh/config` 与 `Include` 展开的文件，收集 alias 名单
2. 对 alias 采用受控 `ssh -G <alias>` 解析最终结果，再提取需要字段

原因：

- `ssh -G` 更接近用户真实命令行行为
- 能减少手写 SSH config 解析规则和 OpenSSH 实际行为不一致的问题
- 对 `Include`、默认值、覆盖顺序的兼容性更高

### 执行保护与性能边界

为避免 `ssh -G` 对弹窗交互造成抖动，必须加保护：

- 单次 `ssh -G` 设置超时（例如 1s~2s），超时即判失败并回退
- 限制并发数（例如 2~4），避免 alias 过多时瞬时拉满 CPU/IO
- 设置可解析 alias 数量上限，超限时只解析前 N 项并给出降级提示
- 任一 alias 解析失败只影响该项，不影响整体列表返回
- 对解析结果做短时缓存（TTL），避免弹窗反复打开时重复扫描与执行
- 执行 `ssh -G` 时禁用交互式输入能力，防止进入密码/确认阻塞

### 回退策略

如果当前环境无法执行 `ssh -G`，则回退到内置轻量解析：

- 识别 `Host`
- 识别 `HostName`
- 识别 `Port`
- 识别 `User`
- 识别 `IdentityFile`
- 识别 `Include`

### alias 过滤规则

只展示“可直接点击连接”的 alias，不展示以下模式：

- `*`
- 含 `?` 的模式
- 含 `!` 的 negated 模式
- 多个 pattern 混在一起、语义不稳定的规则项

这样可以避免把“规则模板”错误地展示成“可直接连接的节点”。

## 字段映射规则

| SSH config 字段 | 表单字段 | 说明 |
| --- | --- | --- |
| `HostName` | `host` | 若缺失则可回退为 alias 本身 |
| `Port` | `port` | 保持数字到字符串转换 |
| `User` | `username` | 直接填入 |
| `IdentityFile` | `privateKeyPath` | 取首个可用值 |

补充规则：

- 若 alias 只有 `Host` 没有 `HostName`，可用 alias 自身作为 `host` 预填。
- 若存在 `IdentityFile`，自动切换到 `Private Key` 认证方式。
- 若不存在 `IdentityFile`，不自动切换到 `Password`，保持当前认证方式，避免覆盖用户已输入的密码。
- 自动填充 alias 时不要写入密码字段。

## 表单状态设计

建议在 `useRemoteConnectionForm` 中新增：

- `sshConfigAliases`
- `sshConfigAliasesLoading`
- `sshConfigAliasesError`
- `selectedSshConfigAlias`
- `applySshConfigAlias(alias: SSHConfigAliasOption)`
- `clearSelectedSshConfigAlias()`

状态职责：

- `useRemoteConnectionForm` 负责加载、缓存、应用 alias
- `RemoteConnectionFields` 只负责渲染下拉和调用 setter

这样可以把“平台数据加载”和“UI 展示”继续放在现有 hook + 组件职责边界内。

## 历史记录与重连策略

远程历史记录仍应保存展开后的 SSH 目标，而不是 alias 名本身。

原因：

- 当前远程连接和自动重连都是基于 `RemoteTarget` 具体字段工作的
- alias 名并不是稳定的连接语义，用户随时可能修改 `~/.ssh/config`
- 如果只存 alias 名，下次重连行为会被“当前 SSH config 内容”隐式改变，导致持久化行为不可预测

因此：

- 本次只把 alias 当作“初始化表单”的来源
- 历史记录仍按现有 `host / port / username / privateKeyPath / credential key` 逻辑持久化
- workspace 级去重、会话关联、缓存 key 继续遵循 `workspaceKey = workspaceIdentity?.trim() || workspacePath`
- 远程 workspace identity 的构造与匹配继续复用统一工具（如 `buildRemoteWorkspaceIdentity`），不引入 alias 专用 identity 规则

## UI 文案建议

新增 i18n key：

- `ssh.configAlias`
- `ssh.configAliasPlaceholder`
- `ssh.configAliasEmpty`
- `ssh.configAliasLoadFailed`
- `ssh.configAliasDescription`

文案方向：

- 中文：`SSH 配置别名（可选）`
- 英文：`SSH Config Alias (Optional)`

## 实施步骤

### 阶段 1：平台能力打通

- shared 增加 `SSHConfigAliasOption`
- `IPlatformService` 增加 `listSSHConfigAliases()`
- desktop preload / renderer / main / web fallback 打通调用链
- web remote control 类型链路补齐兼容

### 阶段 2：desktop 解析器落地

- 新增 desktop runtime 工具，负责读取和解析 SSH config
- 先实现 alias 列表提取与基础字段映射
- 优先尝试 `ssh -G`，失败后回退轻量解析
- 增加针对 `Include`、模式 alias、`IdentityFile` 的单测

### 阶段 3：UI 接入

- 先读取并对照项目根目录 `DESIGN.md`，确保颜色、层级、圆角、尺寸、响应式、主题与 i18n 规则不被破坏
- `useRemoteConnectionForm` 加载 alias 列表和选中状态
- `RemoteConnectionFields` 渲染下拉与提示
- alias 选中后回填表单
- 用户手动编辑关键字段时清除 alias 选中状态

### 阶段 4：测试与回归

- UI 单测
- desktop main / parser 单测
- e2e 覆盖 SSH dialog 下拉选择和字段自动填充
- 跑 `pnpm typecheck`
- 跑 `pnpm lint`

## 测试建议

### 单元测试

- SSH config 解析：
  - 单个 alias
  - 多个 alias
  - `Include`
  - 含模式项时过滤
  - `IdentityFile` 提取
- 表单状态：
  - 选择 alias 后正确回填
  - `IdentityFile` 存在时切到 `privateKey`
  - 手动编辑后清空 alias 选中状态

### E2E

- SSH dialog 打开后出现 alias 下拉
- 选择 alias 后 `host / port / username / privateKeyPath` 自动更新
- 无 alias 时不阻塞手动连接

## 风险与注意事项

### 风险 1：用户预期“alias 等于完整 OpenSSH 兼容”

这是最大的产品风险。需要明确告知：

- v1 支持的是“alias 自动填表”
- 不是“完整复刻 `ssh alias` 的全部语义”

### 风险 2：解析结果和真实 OpenSSH 行为不一致

缓解方式：

- 优先用 `ssh -G`
- 只提取当前 UI 真正可消费的字段
- 对不支持的复杂配置不做虚假承诺

### 风险 3：Web / desktop 行为分裂

缓解方式：

- 保持接口统一
- web 明确返回空数组
- 不让 UI 直接依赖 desktop 特有对象

## 结论

推荐把这项功能定义为：

> 在 SSH dialog 中增加一个基于本机 `~/.ssh/config` 的 alias 下拉菜单，选择后自动填充当前 SSH 表单，并继续沿用现有 `connectRemote()` 流程连接。

这个方案的优点是：

- 与当前分层一致
- 对现有 `RemoteTarget`、远程历史记录、自动重连影响最小
- 用户价值明确
- 可以先交付高频场景，再视反馈决定是否继续扩展到完整 OpenSSH alias 语义支持
