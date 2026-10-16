# SEA SMB Upload

## 背景

`docs/design/v2/sea-cross-target-packaging.md` 已经定义首批 6 个 SEA binary：

- `zcode-darwin-arm64`
- `zcode-darwin-x64`
- `zcode-linux-arm64`
- `zcode-linux-x64`
- `zcode-windows-arm64.exe`
- `zcode-windows-x64.exe`

这些文件生成在 `packages/cli/dist`，发布时需要上传到内部 SMB 共享的
`zcode/deps/zcode-cli-<version>` 目录。`<version>` 必须来自仓库根 `package.json`
的 `version`，与 CLI 版本来源保持一致。

## 目标

- 提供一个可单独运行的 Node.js 脚本上传 6 个 SEA binary。
- 默认上传到已挂载的 SMB 目录 `/Volumes/shared/zcode/deps/zcode-cli-<version>`。
- 上传前检查目标版本目录是否已存在。
- 目标版本已存在且未传 `--force` 时，交互提示用户放弃或强制更新。
- 上传过程中显示文件级和总量级进度。
- 支持通过参数覆盖 dist 目录、目标根目录、SMB URL 标签和版本号，便于测试与临时发布。
- 不新增 `ZCODE_*` 环境变量，不把 SMB 密码写入仓库、日志、命令行示例或测试 fixture。

## 非目标

- 不实现完整 release pipeline、签名、校验和清单或包管理器发布。
- 不实现 SMB 协议客户端。脚本只通过 Node.js 文件系统 API 写入已挂载的共享目录。
- 不自动保存、读取或打印 SMB 密码。凭据交给操作系统 SMB 挂载、钥匙串或管理员流程处理。
- 不在默认路径缺少 `/Volumes/shared` 时自动创建本地同名目录，避免误把产物复制到本机假挂载点。

## 用户接口

- `node packages/cli/scripts/upload-sea-smb.mjs`
- `node packages/cli/scripts/upload-sea-smb.mjs --force`
- `node packages/cli/scripts/upload-sea-smb.mjs --dest-root /Volumes/shared/zcode/deps`
- `node packages/cli/scripts/upload-sea-smb.mjs --dist packages/cli/dist`
- `node packages/cli/scripts/upload-sea-smb.mjs --version 0.12.3`
- `pnpm --filter @zcode/cli upload:sea`

默认值：

- SMB URL 标签：`smb://10.0.0.100/shared`（可通过 `INTRANET_MACHINE_HOST` 覆盖 host）
- 挂载根：`/Volumes/shared`
- 目标根目录：`/Volumes/shared/zcode/deps`
- 版本目录：`zcode-cli-<root package version>`

`--smb-url` 只用于错误提示和日志里的目标说明，不参与认证，也不包含密码。

## 上传契约

脚本必须从 `supportedTargets` 和 `outputBinaryName()` 得到完整文件列表，避免手写 6
个产物名后与打包契约漂移。

上传流程：

1. 读取根 `package.json` 的 `version`，或使用 `--version`。
2. 校验版本字符串不能为空，不能包含路径分隔符或 `.` / `..` 目录名。
3. 校验 `packages/cli/dist` 下 6 个 SEA binary 均存在且是普通文件。
4. 校验默认挂载根 `/Volumes/shared` 已存在；自定义 `--dest-root` 可以按需创建。
5. 创建目标根目录。
6. 如果 `zcode-cli-<version>` 已存在：
   - `--force`：继续强制更新。
   - 交互 TTY：提示用户选择 `abandon` 或 `force`。
   - 非交互：中止并提示使用 `--force`。
7. 先复制到同一目标根目录下的临时 staging 目录。
8. staging 复制完成后再替换目标版本目录，降低半成品暴露时间。
9. 上传完成后输出目标目录、文件数量和总字节数。

强制更新的替换策略是删除已有版本目录后把 staging 目录 rename 到最终目录。
删除范围必须限制在 `zcode-cli-<version>` 目录，不允许删除目标根目录或任意上级目录。

## 进度契约

复制时必须基于 stream chunk 统计字节数，输出：

- 当前文件序号和文件名。
- 当前文件已复制字节数 / 文件大小。
- 总已复制字节数 / 总大小。
- 总百分比。

TTY 下可以复用单行刷新；非 TTY 下输出离散进度行，避免长时间无输出。

## 错误行为

- 根 `package.json` 不存在、无法解析或 `version` 无效：中止。
- 缺少任一 SEA binary：中止，并提示先运行 `pnpm --filter @zcode/cli build:sea`。
- 默认 SMB 挂载根不存在：中止，并提示先挂载 `smb://10.0.0.100/shared`。
- 目标版本已存在且用户选择放弃：不修改目标目录，退出成功。
- 目标版本已存在且非交互又未传 `--force`：中止。
- staging 复制失败：清理 staging 目录，保留已有版本目录。
- rename 或删除失败：向上抛出原始错误原因，由 CLI 边界格式化。

## 测试覆盖

- 参数解析，包括默认值、`--force`、`--dest-root`、`--dist`、`--version` 和未知参数。
- 版本目录名来自根 `package.json`，并拒绝路径穿越版本。
- SEA binary 列表来自 `supportedTargets` 映射，缺失文件时报错。
- 已有版本目录选择 `abandon` 时不复制文件。
- 已有版本目录选择 `force` 或传 `--force` 时替换目标目录。
- 复制过程发出进度事件，并保留文件内容。
- 默认挂载根缺失时不创建 `/Volumes/shared` 假目录。
