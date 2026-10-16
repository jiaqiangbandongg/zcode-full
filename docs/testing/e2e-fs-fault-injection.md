# E2E FS Fault Injection

目标：为会话区外部环境故障提供稳定、可复现的文件系统错误注入能力，让 `ENOSPC`、`EACCES`、损坏快照、日志写入失败等 case 可以在本地、CI、Docker 中以同一协议复现，而不是依赖真实磁盘写满或手工改权限。

关联 case：

- `D01`：session history 写入 `ENOSPC`
- `D02`：workspace 文件写入 `ENOSPC`
- `D03`：provider/settings 保存 `EACCES`
- `D04`：启动恢复 session snapshot 损坏
- `D05`：日志/artifact 写入失败

## 注入边界

文件系统故障只能在测试运行态启用。默认只接受 `ZCODE_ENV=test` 下的注入配置；若未来需要在特殊调试包里启用，必须显式设置 `ZCODE_E2E_FS_FAULTS_ALLOW=1`，避免用户生产环境因为环境变量残留被注入错误。

第一阶段先提供独立 helper，并先接入 `atomicWriteText` 这类配置原子写入口。后续接入顺序：

1. provider `config.json` 原子写入：已接入，可覆盖 `D03` 的核心保存路径。
2. settings `setting.json` 直接写入：已接入，可补齐 `D03` 的 app settings 保存路径。
3. provider display order 直接写入：已接入，可覆盖 provider 偏好保存失败。
4. SQLite session DB open：已接入，可覆盖启动/恢复时数据库打不开，服务于 `D04`。
5. SQLite session history write：已接入 `sqliteRun`，可覆盖 `saveMessage` / `savePart` / `createSession` 等写入失败，服务于 `D01` 和 compact marker 写入。
6. workspace tool 文件写入：接入 `NodeFileSystemAdapter.writeTextFile` 的 `createParents`、非原子直接写入和删除边界，服务于 `D02`；默认 `atomic: true` 的 temp 写入、chmod、sync、rename 和 fallback 不接入 fault injector。
7. tool artifact sink：接入 `NodeToolArtifactStore` 的目录创建和文本/二进制 artifact 写入，服务于 `D05` 的 artifact 分支。
8. CLI log sink：接入 `NodeLoggerFactory` 的日志目录创建和 JSONL append，覆盖 `D05` 的 CLI 日志写入分支。
9. desktop main log sink：接入 main 进程普通日志和 web remote control 专用日志的 append，覆盖 `D05` 的桌面主进程日志写入分支。启动期日志目录创建失败仍保持现有行为，后续若要改为完全吞错，需要单独确认产品预期。

### Workspace atomic write 说明

`NodeFileSystemAdapter.writeTextFile` 的默认 `atomic: true` 路径：写入 temp 文件、复制原文件权限、sync、rename；若该 atomic 路径失败，会清理 temp 文件，并 fallback 到 `O_TRUNC` 非原子写入目标文件。这个 fallback 在 `ENOSPC` / `EIO` 等异常磁盘错误下可能截断已有目标文件；当前 file tools 权限回归暂接受这一行为。

为避免 test-only `ZCODE_E2E_FS_FAULTS` 污染这条 prod 逻辑，workspace 默认 atomic temp 写入 / rename 不插入 fault hook。`D02` 若需要稳定模拟 workspace 写失败，应使用 `atomic: false` 的直接写入、父目录创建、删除或其他已接入的存储边界；是否为默认 atomic 路径重新引入专用测试 seam，需要先单独确认产品语义。

## 配置格式

环境变量：`ZCODE_E2E_FS_FAULTS`

值为 JSON 数组，每条 rule 描述一个故障等价类：

```json
[
  {
    "id": "D01-session-history-enospc",
    "code": "ENOSPC",
    "operations": ["writeFile", "rename"],
    "pathIncludes": "/.zcode/",
    "maxMatches": 1,
    "message": "Injected ENOSPC while persisting session history"
  }
]
```

字段含义：

| 字段 | 含义 |
| --- | --- |
| `id` | 稳定 case id 或 fixture id，必须非空 |
| `code` | Node 风格错误码，如 `ENOSPC`、`EACCES`、`EPERM` |
| `operations` | 匹配的 fs / storage 操作；支持 `mkdir`、`writeFile`、`appendFile`、`rename`、`rm`、`sqliteOpen`、`sqliteRun`、`any` |
| `pathIncludes` | 路径包含匹配；路径会统一把 `\` 规范成 `/` |
| `pathEndsWith` | 路径后缀匹配 |
| `pathRegex` | 正则匹配规范化后的路径 |
| `maxMatches` | 最大命中次数；默认 `1`；`0` 表示无限命中 |
| `message` | 注入错误的可读说明 |

匹配规则：

- `operations` 缺省等价于 `["any"]`。
- `pathIncludes` / `pathEndsWith` / `pathRegex` 都缺省时，匹配所有路径。
- 多个 path 条件同时存在时必须全部满足。
- `maxMatches` 默认只触发一次，避免一个 fault case 无意中污染后续无关写入。

## 错误对象

注入器抛出的错误必须保留 Node `ErrnoException` 形状：

```ts
{
  code: "ENOSPC",
  syscall: "writeFile",
  path: "/tmp/workspace/.zcode/session.json",
  zcodeFsFaultId: "D01-session-history-enospc"
}
```

这样产品层可以按真实错误码处理，E2E artifact 又能定位命中的 rule。

## 验收证据

每条存储 fault E2E 至少要保留这些证据：

| 层 | 证据 |
| --- | --- |
| UI | 用户可见错误、按钮状态、queue/runtime 是否符合产品预期 |
| Runtime | `activeInputId`、queue、session status、compact marker |
| Files | 目标文件是否缺失、部分写入、损坏或恢复成功 |
| Log | 同一 `sessionId` / `inputId` 的错误码和恢复日志 |
| Fault artifact | 命中的 `id`、`operation`、`path`、`code`、命中次数 |

## 当前状态

第一阶段已固化注入协议、helper 单测，并把 provider/config 使用的 `atomicWriteText`、`setting.json` 直接写入、provider display order 写入、SQLite session DB open、SQLite session history write、workspace tool 的父目录创建 / 非原子直接写入 / 删除、tool artifact write、CLI JSONL log write、desktop main log append 接入注入点；`D01-D05` 仍保持 `decision-needed`，不能因为具备注入能力就算产品 case 已覆盖。只有当某个业务写入点接入 helper，并且对应 case 有明确 setup/action/assert 后，才能在覆盖矩阵里标成 `covered`。
