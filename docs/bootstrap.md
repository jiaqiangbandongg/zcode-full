# Bootstrap 命令

`pnpm bootstrap` 是默认本地初始化入口。它会先拉取 `apps/zcode-cli` submodule，再安装依赖、准备 desktop 本地 runtime 资源，并执行 bootstrap 构建；默认不准备 remote `mock-cdn` 资源。

`pnpm bootstrap:with-remote` 保留远程调试需要的完整初始化流程。它会先拉取 `apps/zcode-cli` submodule，再安装依赖、准备 desktop 本地 runtime 资源并执行 bootstrap 构建，最后通过 `@zcode/server-cli stage:remote-assets` 生成 `source-server-release.json` 与四个平台 archive。它不再生成 legacy manifest/components。

如只需要单独准备 Source Server 资源，可以执行 `pnpm prepare:remote-assets`。

Linux SSH 开发验证使用 `pnpm prepare:remote-assets:linux`，只构建 `linux-x64` 和
`linux-arm64`，不执行 submodule 初始化、依赖安装或其它 workspace 的 bootstrap 构建。
该命令复用 Source Server staging：构建一次 Server CLI/Core，第一目标构建 Agent 和所需
插件 runtime，第二目标复用同轮 Agent；各目标仍携带完整的 Node、工具、依赖与插件资源。
前提是工作区已安装依赖。它不启动 Desktop，也不自动连接或更新远端。

Linux 专用入口只生成 SSH 整包安装需要的两个完整 archive，不生成独立组件归档。
staging 仍计算各组件的 `paths`、`sha256`、`sizeBytes` 并写入包内 manifest，只省略
组件 `archivePath`，跳过组件二次哈希、临时复制和压缩。原全平台入口继续生成组件归档。
重新 staging 时清理该目标的旧组件归档，避免把历史文件误认成本轮产物；完整资源组装、
插件 runtime 与许可声明校验、整包 SHA/大小及 descriptor 发布规则均保持原行为。

新命令的 `ZCODE_ENV` 未设置或空白时默认为 `production`，与 `pnpm dev:desktop` 一致；
显式值去除首尾空白并转为小写，只接受 `test` / `production`，非法值在构建和产物变更前失败。
测试环境使用 `ZCODE_ENV=test pnpm prepare:remote-assets:linux`，随后启动
`pnpm dev:desktop:test`。原 `prepare:remote-assets` 和 `bootstrap:with-remote` 仍构建四个平台。

```text
撤销旧 descriptor → 构建 Server CLI/Core → Linux x64（构建 Agent）
                  → Linux arm64（复用 Agent）→ 发布 Linux 双架构 descriptor
每个目标：资源组装与校验 → 一次组件哈希 → manifest → 整包压缩（无独立组件归档）
```

两个 archive 写入当前版本的 `packages/desktop/mock-cdn/releases/<version>/`，
`source-server-release.json` 只包含本轮两个 Linux 目标及其 SHA/大小，不合并旧 macOS 条目。
任一目标失败，不发布新 descriptor；已有 macOS archive 文件不主动删除，但不被该 descriptor
引用。需要恢复 macOS 验证时重新执行全平台入口。构建命令不得并发写入同一工作区的发布目录。
回归测试覆盖真实 CLI 的目标选择、Agent 复用参数、环境传递、失败中止，以及双架构
archive/descriptor 发布和旧条目淘汰；不以完整远端构建或 SSH 实机验证代替这些测试。
组件归档优化还需覆盖：Linux 入口传递跳过参数、全平台入口保留原行为、完整包可安装、
组件哈希与默认打包一致、旧组件归档被清理，以及缺少必需资源时仍失败。

`bootstrap:with-remote` 准备 desktop 官方插件 runtime 时，必须先清理该插件的旧
`dist`；插件根目录有 `tsconfig.json` 时先执行 TypeScript 编译，再执行 runtime 打包和产物校验。
文档插件的源码位于共享 `office-runtime`，无自身 tsconfig 时直接执行声明的构建脚本。清理所用的文件系统 API
必须显式导入；清理或构建失败时继续向入口传播错误，不得复用旧产物。回归验收执行
真实清理函数，覆盖有、无 tsconfig 的插件，以及旧 `dist` 存在及不存在的情况，确认清理发生在构建命令之前。

## 远程初始化的产品环境

`bootstrap:with-remote` 在入口统一选择产品环境：未设置或空白的 `ZCODE_ENV` 默认选择
`production`，与随后执行的 `pnpm dev:desktop` 一致；显式 `test` / `production` 经去除首尾
空白、转为小写后传给全部构建子进程。非法值必须在安装依赖、清理或构建之前报错。
本地 runtime、Source Server Core 与远端 Agent 必须使用同一选择，不能在子构建中重新退回
测试环境。

```text
修复前：bootstrap:with-remote -> 未指定环境 -> 远程包 test
        dev:desktop           -> production -> 生产凭据发往测试模型地址 -> 401
修复后：bootstrap:with-remote -> 入口选择 production -> 同环境的本地与远程产物
        dev:desktop           -> production -> 生产凭据与模型地址匹配
```

测试环境联调时，先以 `ZCODE_ENV=test` 执行 `bootstrap:with-remote`，再运行
`pnpm dev:desktop:test`。显式选择测试环境后，普通 `dev:desktop` 仍然表示 production，
不会自动重建或转换远程安装包。已有测试环境 archive 需要重新构建并更新远端才能改为生产环境。

普通 `bootstrap`、独立 `prepare:remote-assets` 和通用构建器保留原有环境选择规则；
本次入口约束不改变 Provider Provisioning 的内置配置权威、运行时协议或任务恢复语义。
回归验收覆盖默认/空白值、显式两种环境、非法值提前失败，以及普通 bootstrap 的原有行为；
拦截构建子命令，验证真实入口传出的环境与实际选中的 Built-in Provider 模型地址。

## Agent 共享迁移模块的构建边界

CLI、Desktop agent 与 SEA 复用 `apps/zcode-cli/packages/cli/scripts/build.mjs`
的 alias 配置。`@zcode/shared/sqlite-migrations` 必须精确解析到
`packages/shared/src/node/sqliteMigrations.ts`，并打入 Agent bundle；否则通用
`@zcode/shared` alias 会把子路径拼到 `src/index.ts` 后面，导致 bootstrap 打包失败。
构建回归测试使用真实 session migration 入口与 esbuild，验证共享实现被内联且没有
遗留该子路径的外部依赖。本修复只调整构建解析，不改变迁移 SQL、checksum、账本或执行顺序。

