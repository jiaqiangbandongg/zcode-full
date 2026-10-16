# Todo 33：Personal Provider Config 独立文件与旧 Store 退役

> 状态：已完成
>
> 日期：2026-08-28
>
> 来源：Provider Refactor 上线前配置存储复核
>
> 关联任务：[`Todo 06`](./todo-06-config-storage-envelope-repository-privatization.md)、
> [`Bugfix 05`](./bugfix-05-personal-config-worker-refresh.md)

## 1. 问题

当前 Personal Provider Config 默认落在 Environment 配置目录的 `config.json`。该文件名同时被旧 ZCode/CLI
综合配置使用，导致正式 Personal 文件、Legacy Importer 输入和其他产品配置在物理命名上发生冲突。Repository 为了
在同一文件上原地改写旧格式，还引入了 `pre-provider-v1` 备份与损坏恢复覆盖。

此外，已经退役写入的 `model-providers.json` 仍被 Desktop Legacy Reader 作为回退输入；Remote Workspace 还可能从该
旧 Store 搬运 Coding Plan API Key。这两条兼容链不再属于上线目标。

## 2. 最终裁决

Personal Provider Config 与 Personal Model Config Rules 统一保存在所属 Environment 配置目录下的：

```text
provider_config.json
```

文件内容继续使用 Repository 私有版本信封：

```text
schemaVersion
providerOrder
providers
modelConfigRules
```

`provider_config.json` 是唯一正式 Personal Provider/Model Config 文件。`model-selection.json`、ZCode Built-in
Active/LKG、Account Config、MCP/Plugin/Hook 使用的其他 `config.json` 均保持独立。

本功能尚未上线，因此：

- 不识别或迁移当前开发分支曾写入 `config.json` 的 Provider v1 中间格式；
- 不读取 `model-providers.json`；
- 不从旧 Provider Store 迁移 Coding Plan API Key；
- 不生成迁移备份；
- 不删除、不改写 Legacy `config.json`，它仅作为已发布旧配置的一次性只读输入。

## 3. 迁移与进程职责

### 3.1 Desktop / Web Host Environment

```text
Local Host Provider Runtime.start()
        |
        v
锁定 provider_config.json
        |
        +-- 已存在 --> 读取正式文件
        `-- 不存在 --> 只读旧 config.json
                         |
                         v
                    转换为稀疏 Personal Overlay
                         |
                         v
                    原子写 provider_config.json
        |
        v
Host Registry ready
        |
        v
允许派发 Agent Runtime Env / 启动 Worker
```

Desktop 每个窗口拥有一个 Local Host；多个窗口可以共享同一 Environment 配置目录。首次迁移必须在目标文件锁内重新
检查是否存在，使多个 Host 的并发初始化幂等。Host 必须先完成 Provider Runtime 初始化，再向 Agent 派发正式路径。

### 3.2 Desktop Agent Worker

Desktop 派发的 Agent Worker 只通过 `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` 读取 `provider_config.json`。它不持有
Legacy Importer，不参与迁移；长期存活时继续使用 Bugfix 05 的 content-revision 轮询追踪外部写入。

### 3.3 Standalone CLI

Standalone Prompt CLI/TUI 是自身 Environment 的组合根。它在 `~/.zcode/v2/provider_config.json` 缺失时，只读既有
CLI 用户 `config.json` 并执行一次性导入。协议 Worker 路径仍只读正式文件。

## 4. Repository 语义

- 默认目标文件名统一为 `provider_config.json`；显式注入的测试/宿主路径继续受支持；
- 首次读取在目标文件锁内完成“存在性检查 -> Legacy 导入 -> 原子写”；
- Legacy Reader 只有读取返回 `ENOENT` 才视为源文件不存在；IO、JSON 解析、schema 校验失败必须向
  Repository 抛出错误，不能转换成空 Provider 列表。读取失败时沿用现有内存降级与 recovery 回调，
  不创建 `provider_config.json`；写入命令遇到相同故障必须失败，防止把首次迁移错误永久固化为空配置。
  下一次读取可重新尝试导入；不添加超时补偿、第二份迁移状态或旧文件监听。
- Legacy 读取错误只包含源路径、失败阶段、系统错误码或校验字段路径，不包含原始 JSON、凭据值或
  原始解析错误。由宿主现有 `onPersonalConfigRecovery` 记录；错误内容不得通过 cause 泄露原文。
  此边界同样适用于 Desktop / Web Host，Worker 与手机实时消息的 delivery 语义不变。
- Legacy 源文件始终保持不变，因此删除 `backupPersonalProviderConfigBeforeMigration`、`backupFilePath` 和全部
  `.pre-provider-v1-*.bak` 行为；
- 正式文件未来的 `schemaVersion` 迁移直接通过原子写提交，不额外制造备份；
- 正式文件损坏时不得伪装成 Legacy 输入。Repository 保留原文件，以内存空 Personal Overlay 降级并报告错误，不为
  保证 ready 而覆盖用户文件；
- Repository 本进程 `update()` 仍即时发布 `updated`；其他进程只轮询 `provider_config.json` 的内容 revision；
- 旧 `config.json` 或 `model-providers.json` 后续变化不得触发 Registry 刷新。

## 5. 旧链清理

### 5.1 `model-providers.json`

- 删除 Desktop Legacy Reader 的文件回退、旧 Store 多版解析和相关日志；
- 剩余 Legacy Reader 只表达“读取旧 ZCode `config.json` 中的 Provider”，并按职责重命名；
- 删除只覆盖 `model-providers.json` 的测试和辅助类型；
- 不监听、不迁移、不删除磁盘上可能残留的文件。

### 5.2 Account Coding Plan Key

- 删除 `legacyAccountProviderApiKeyLoader`；
- 删除 Account Credential Store/Service 的 `loadLegacy` 参数；
- 删除 Remote Workspace 对旧 Provider Store 的 Key 读取；
- 当前账号 Key 只从账号作用域 Credential Store 读取，缺失时经当前 OAuth/服务端解析并写入正式凭据存储。

## 6. 路径覆盖

必须统一修改：

- Desktop Local Host 默认 Personal Config 路径；
- Host 派发给本地/远程 Agent 的 `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE`；
- Standalone CLI 的 `~/.zcode/v2/provider_config.json`；
- Desktop E2E 的 Provider Config seed；
- Provider Node、Services、CLI、Desktop 的路径与迁移测试。

不得批量改名其他 `config.json`。以下文件明确不属于本 Todo：

- `~/.zcode/cli/config.json`；
- workspace `.zcode/config.json`；
- MCP、Plugin、Hook、Command、Skill 配置；
- `model-selection.json`；
- ZCode Built-in Active/LKG 文件。

## 7. 测试计划

先写失败测试，再改生产实现：

1. Desktop/Services 默认目标为同目录 `provider_config.json`；
2. Standalone CLI 默认目标为 `~/.zcode/v2/provider_config.json`；
3. 目标不存在时从旧 `config.json` 一次性导入，旧文件字节不变且不产生 `.bak`；
4. 目标存在时不调用 Legacy Importer；
5. `model-providers.json` 即使存在也不会被读取；
6. 两个 Runtime 并发首次启动只产生一个完整正式文件；
7. Host 在 Agent Runtime Env 派发前已经完成 Personal 初始化；
8. 两个 Repository 指向新文件时，正式原子写仍在一个轮询周期内刷新观察方；
9. 旧文件变化不会触发 Personal change；
10. Account Credential Store/Service 缺失当前 Key 时不再读取旧 Provider Store；
11. Desktop Provider Settings 保存、重启和连接测试继续使用同一个新文件；
12. macOS、Windows、Linux 路径均通过 Node `path` 组合，不依赖分隔符。

## 8. 完成标准

- 生产默认路径中不再存在 Personal Provider `config.json`；
- 生产代码不再读取 `model-providers.json`；
- 生产代码不存在旧 Coding Plan Provider Key Loader 或 `loadLegacy` 凭据参数；
- 不再创建 Personal Provider Config 迁移备份；
- Host/Worker/Standalone 对同一 Environment 使用同一个 `provider_config.json`；
- Personal content-revision 轮询、连接测试主动刷新和 Active Model 冻结语义保持不变；
- 定向测试、相关 E2E、`pnpm typecheck`、`pnpm lint` 和修改文件格式检查通过。

## 9. 实施结果

- `PERSONAL_PROVIDER_CONFIG_FILE_NAME` 成为 Host、Services 与 Standalone CLI 共用的正式文件名事实；Desktop
  E2E seed 和夹具同步切换到 `provider_config.json`；
- Repository 的 Legacy importer 只在目标缺失时调用，并在目标文件锁内完成导入和原子创建；已有正式文件
  不再被当作无版本输入，也不再生成或恢复 `.bak`；无效正式文件保持原样并以内存空 Overlay 降级；
- Local Host 在派发 Agent Runtime Env 前等待 Provider Runtime 初始化，Worker 只接收正式文件路径并继续使用
  content-revision 轮询；
- 旧 Reader 已按剩余职责改名为 `legacyZCodeConfigProviderReader`，只读取已发布旧 `config.json`；生产源码中
  `model-providers.json` 引用归零；
- `legacyAccountProviderApiKeyLoader`、Credential Store/Service 的 `loadLegacy` 参数和 Remote Workspace 旧 Key
  搬运全部删除；
- 迁移、路径、并发、坏文件、结构门禁、Credential 与 CLI/Bootstrap 定向测试通过；根 `pnpm typecheck`、
  `pnpm lint` 和全量 `pnpm test:unit` 通过。全量结果为 1487 个文件通过、1 个跳过，12675 条测试通过、
  25 条跳过。
