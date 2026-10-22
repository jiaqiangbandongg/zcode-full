# TMPDIR 写入收口规范

## 背景

系统临时目录可能被宿主环境、沙箱或企业安全策略限制权限。ZCode 产品主路径如果依赖 `TMPDIR` / `os.tmpdir()` 写入，会导致日志导出、反馈上传、剪贴板图片读取、checkpoint 构建或命令输出持久化在部分环境中失败。

## 目标

- 除下述 Bash 输出例外外，可控的 ZCode 临时/持久化文件落在数据根目录下，默认是 `~/.zcode`。
- Bash 输出优先使用系统临时目录，目录不可用时复用数据根下的原有输出实现。
- 不迁移历史文件，不额外扫描旧 `TMPDIR` 布局；已有输出引用仍沿用实际路径读取。
- 本次不修改 remote asset fallback，也不修改官方 iOS / Android 模拟器插件路径。

## 路径规范

| 场景                      | 新路径                                                                                             | 生命周期                                       |
| ------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| zcode-cli Bash 持久化输出 | `<os.tmpdir()>/zcode-bash-<随机标识>/<session>/<tool>-stdout.log`；降级到 `<storageRoot>/cli/exec` | 具名临时文件，沿用前后台保留规则，接受系统清理 |
| zcode-cli 剪贴板图片      | `~/.zcode/clipboard`                                                                               | 单次读取后删除                                 |
| 日志导出 staging          | `~/.zcode/export-log-stage`                                                                        | 打包完成后删除，异常退出允许残留               |
| 日志导出结果              | `~/.zcode/export-log`                                                                              | 用户可见导出结果，默认保留                     |
| feedback 附件和日志包     | `~/.zcode/feedback`                                                                                | 上传完成后删除                                 |
| Git checkpoint 临时 index | `~/.zcode/git-checkpoint-index`                                                                    | checkpoint 构建完成后删除                      |
| Desktop 编辑器图标转换    | `~/.zcode/editor-icon`                                                                             | 单次转换后删除                                 |

## 约束

- 写入前须准备业务子目录，不能依赖 `mkdtemp` 自动创建父目录。Bash 的系统 tmp 父目录不存在时按 `ENOENT` 降级，不自行创建系统 tmp 根。
- 短生命周期目录必须使用单次唯一子目录，结束后在 `finally` 中清理；Bash retained 输出不随 adapter 关闭删除。
- 失败清理不能影响主流程结果。Bash tmp 输出暂不纳入 App 存储占用统计或清理，其余目录沿用现有管理范围。
- Bash 的自定义 `ZCODE_STORAGE_DIR` / `storageRoot` 也仅作为降级位置；其他文件仍优先使用解析后的 `storageRoot`。
- service / desktop 侧使用现有 data base dir 语义，默认落到 `~/.zcode`，配置了 `ZCODE_DATA_BASE_DIR` 时落到 `{dataBaseDir}/.zcode`。

## Bash 输出例外

递归搜索数据目录会读到正在写入的输出文件；搜索结果又写回同一文件，形成自引用。
主应用及 workflow 子运行时向 execution adapter 注入 `bashOutputTempDir = os.tmpdir()`。
每个 adapter 按需异步 `mkdtemp` 创建私有目录，仅复用成功的创建结果；未传该选项的直接调用保持原行为。
shell 初始化快照、启动脚本与非 Bash 输出继续使用原 `outputRootDir`。

必须实际创建并打开输出文件，不能用 `access` 预检查。仅 tmp 准备阶段的
`EACCES`、`EPERM`、`EROFS`、`ENOENT`、`ENOTDIR`、`ENOSPC`、`EDQUOT` 允许降级。
降级调用原有 `<storageRoot>/cli/exec` 文件准备逻辑；其他错误和降级失败沿现有失败链路结束。
命令启动后不切换路径、不重跑。降级或直接搜索 tmp 时仍可能自引用，此风险不属于本次修复承诺。

文件准备完成后才能发布实际路径。前后台、监控、结果和文件入口共用该路径及已打开的 fd，
stdout/stderr 继续直接写同一文件，输出编码只解析一次。准备期间取消或关闭须释放句柄并禁止 spawn。
前台小输出和超限文件沿用 best-effort 清理，大输出与后台文件沿用保留规则；不 unlink、不退出归档、
不保证系统清理或重启后仍可读取，不改变 5 GiB / 5 秒软阈值。

## 非目标

- 不清理已有 `$TMPDIR/zcode-*` 残留。
- 不修改 remote asset cache fallback。
- 不修改 `apps/zcode-cli/packages/ios-simulator-plugin` 与 `apps/zcode-cli/packages/android-emulator-plugin` 的数据目录。
