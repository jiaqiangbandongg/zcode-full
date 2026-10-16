# Bugfix 05：Personal Config 的 Worker Registry 刷新自愈

> 状态：已完成
>
> 日期：2026-08-27
>
> 来源：macOS Provider Settings 实机连接测试长期报告 `provider-not-found`

> 2026-09-15 锁边界修订：纯轮询和规范格式的普通读取不再使用排他锁；导入、规范化写回与 update 仍使用原写锁。
> 下文记录历史方案，当前锁范围及并发约束见[纯读取去锁 TODO](../../../analysis/2026-09-15-provider-config-read-lock-todo.md)。

## 1. 问题

用户在 Provider Settings 中保存新的 Personal Provider 后，Host Settings View 已经展示该 Provider，模型连接测试却可
长期返回：

```text
Provider Registry 中不存在 Provider: <providerId>
```

反复点击连接测试不会恢复；Worker 重启、应用重启或后续某次文件变化后可能恢复。

这不是正常的异步刷新延迟。Host 与 Core Worker 各自持有进程内 Provider Registry：Host 保存后会主动刷新自己的
Registry，Worker 只在 Personal Config 外部变化被观察到时刷新。当前唯一跨进程观察手段是 `fs.watch`；事件一旦漏掉，
Worker 没有轮询、主动重读或其他自愈入口，会无限期服务旧 Registry。

## 2. 根因

生产保存使用原子写：先写同目录临时文件，再 `rename` 为 `config.json`。当前 Personal Repository 监听目录，并且只在
`fileName` 为 `null` 或精确等于目标文件名时调度重读。

```text
Host
├─ write .config.json.<pid>.<time>.tmp
└─ rename tmp -> config.json
          |
          v
macOS / Windows / Linux 的 fs.watch 事件形态不一致
          |
          +-- 精确报告 config.json --> Worker 刷新
          `-- 临时名、漏事件或 watcher error --> 当前实现不再自愈
```

同时存在三个放大条件：

- watcher `error` 只发布错误事件，不清理或重建失效实例；
- watcher 触发后的读取失败只发布错误，没有后续重试；
- 连接测试只主动同步 Account Config，不重读 Personal Config，连续点击仍查询同一份旧 Worker Registry。

现有测试使用直接 `writeFile(config.json)` 模拟外部修改，没有覆盖两个独立 Runtime 配合正式原子写，也没有覆盖文件事件
完全丢失后的恢复。

## 3. 最终裁决

Personal Config 不再使用 `fs.watch`。Repository 只保留一种跨进程变化观察机制：低频、异步地重读目标文件并比较
content revision。

```text
Repository start/read
        |
        v
记录 observed content revision
        |
        v
异步轮询（默认约 1 秒）
        |
        v
在文件锁内读取 Personal Config
        |
        +-- revision 相同 --> 不发布事件
        `-- revision 变化 --> 更新 observed revision
                              + 发布 personal:poll-changed
                              + Registry 正常 refresh
```

不得同时保留 `fs.watch + poll` 两套长期机制，也不增加 Host/Worker revision barrier、完整 Config 传输或 Registry Snapshot
同步。轮询只读取当前 Environment 的本地 Personal Config 文件，不访问服务端，不属于远端 Built-in 刷新。

## 4. Repository 实现约束

### 4.1 单一异步轮询循环

- 第一次 `read()` 或 Runtime `start()` 后启动轮询；
- 默认间隔约 1 秒，测试可以注入更短间隔；
- 每一轮完成后才调度下一轮，不允许慢 IO 导致多个读取重叠；
- 使用异步文件 IO 和现有文件锁；
- 比较正式内容 revision，不依赖文件名、mtime、size 或 inode；
- revision 未变化时不发布 Source change，不触发 Registry replace；
- 读取、锁或解析暂时失败时报告可观测错误，下一轮继续尝试；
- Timer 必须 `unref()`，不得阻止 Node 进程退出；
- Repository `dispose()` 后取消下一轮调度，任何在飞读取完成后也不得发布事件。

删除 `FSWatcher`、目录事件过滤、watcher error handler 和 watcher 重建相关状态。现有 `watch?: boolean` 若只表达测试关闭
外部变化观察，应一次性改为语义明确的 polling option，不保留误导命名的兼容层。

### 4.2 本进程显式更新仍即时发布

Repository 自己执行 `update()` 时，继续在原子写完成后立即更新 `observedRevision` 并发布一次 `updated`：

```text
当前 Repository.update()
        |
        +-- 原子写完成
        +-- observedRevision = new revision
        `-- emit("updated")

下一轮 poll 读到相同 revision
        `-- 去重，不再 emit
```

因此 Host 保存不等待一秒；只有其他进程的 Repository 最迟在下一轮轮询中追上。

## 5. 连接测试主动刷新

模型连接测试是对“当前已经保存的配置”的诊断，不能等待下一轮轮询。Agent 收到 connectivity 请求后，必须先主动刷新
本进程 Config Source 与 Registry，再查找 Provider/Model 并使用正式 Model 执行链测试：

```text
Host 已完成保存
        |
        v
Agent connectivity request
        |
        v
Worker Registry.refresh("provider-connectivity")
├─ 主动读取 Personal Config
├─ 与当前 Account Config 共同 resolve
└─ 等待 Registry 发布完成
        |
        v
精确查找 providerId/modelId
        |
        v
临时创建正式 Model 并测试
```

这里不让 Host 直接实现模型 HTTP 请求：Host 不拥有 Adapter/ModelFactory 正式执行链，复制一套连接协议会产生“测试成功但
真实聊天失败”的第二套行为。也不允许连接测试从 Renderer 草稿、Host Registry Snapshot 或手工拼装的 Provider Config
创建旁路 Model。

主动刷新失败时返回真实 Config/Registry 错误；Provider 保存但不完整时仍应以 Registry 不可执行错误失败，不得绕过 Resolver。

## 6. 正常运行语义

```text
同进程保存       --> 立即刷新当前 Registry
其他进程保存     --> 最迟约一个 polling interval 追上
连接测试         --> 请求开始时立即主动追上
新 Worker 启动   --> 首次 start/read 读取最新文件
Worker 长期存活  --> 轮询持续提供最终一致性
```

轮询刷新只影响后来进行的 Registry 查找和 Model 创建。已经创建的 Active Model 继续冻结，不热改写其 Provider Config、
Model Config、Endpoint 或访问材料。

Desktop Local Host、Web Remote 与 Remote Workspace 均遵守目标 Environment 所有权：每个 Environment 的 Host 与 Worker
只读取该 Environment 自己的 Personal Config。不得把本地 Personal Config 轮询或复制到远程 Environment。

## 7. 测试计划

先写失败测试，再修改生产实现。

### 7.1 Repository

- 两个独立 Personal Repository 指向同一文件，写入方使用正式原子写，观察方在一个 interval 内发布新 revision；
- 不提供任何文件事件时仍能发现变化；
- 相同内容、重复原子写和本进程 `update()` 不产生重复通知；
- 一轮读取未结束时不会开始下一轮；
- 文件锁、暂时缺失或读取失败后下一轮能够恢复；
- `dispose()` 清理 Timer，在飞读取不得在 dispose 后 emit；
- Timer 不阻止进程退出；
- 代码中不再存在 Personal Repository 的 `FSWatcher` 或 `fs.watch`。

### 7.2 Registry 与连接测试

- Worker Registry 在 Personal revision 变化后解析并发布新 Provider；
- 保存 Personal Provider 后立即连接测试，无需等待 polling interval 即可找到 Provider；
- 已有活跃 Session 和临时 connectivity App 都使用刷新后的同一进程 Registry；
- Config 读取失败、Provider 不完整、Model 不存在分别保留准确错误；
- connectivity 主动刷新不创建第二套 Registry、Provider Snapshot 或测试专用 Model DTO；
- 已创建 Active Model 在 Registry 刷新后保持冻结。

### 7.3 回归

- Account Config 继续通过既有 Protocol 显式同步，不并入 Personal 文件轮询；
- ZCode Built-in Active/LKG 与远端刷新机制不变；
- Model Selection、Provider Settings 和普通模型请求最终看到相同 Registry 事实；
- macOS、Windows、Linux 均不依赖各自的文件事件实现。

## 8. 完成标准

- Personal Config 外部变化不再依赖 `fs.watch`；
- Worker 最迟在约一个轮询周期内追上新 content revision，漏事件不能造成永久陈旧；
- 连接测试总是在查找模型前主动刷新当前 Worker Registry；
- 不新增跨进程 revision 协议、Config/Registry Snapshot 同步或 Host 模型执行旁路；
- 定向测试、`pnpm typecheck`、`pnpm lint` 与 macOS 实机“保存后立即连接测试”通过。

## 9. 实施结果

- Personal Repository 已删除 `FSWatcher`、目录事件过滤和串行 watcher refresh，改为默认 1 秒、完成一轮后再调度
  下一轮的异步 content revision polling；Timer 使用 `unref()`，`dispose()` 后不再发布事件；
- 同进程 `update()` 仍即时发布 `updated`，轮询读到相同 revision 会去重；暂时读取失败只在进入错误状态时报告一次，
  后续轮询继续重试并可自行恢复；
- Provider connectivity 协议入口在查找 Provider/Model 和创建正式 Model 前，显式等待当前 Worker
  `ProviderRegistryService.refresh("provider-connectivity")`，没有新增 Host 请求旁路、Registry Snapshot 或测试专用 Model；
- `@zcode/provider-node` 44 个测试、Services Provider Runtime 11 个定向测试、Bootstrap 协议 108 个测试及相关
  typecheck 通过；macOS 实机复验留在最终人工验证阶段。
