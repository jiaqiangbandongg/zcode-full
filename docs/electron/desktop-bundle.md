# Desktop 打包参数

`pnpm bundle:desktop` 现在支持通过参数指定目标操作系统和 CPU 架构，用来驱动不同平台的桌面端打包。

## 桌面 stdio Agent 字节码试验

`pnpm dev:desktop:bytecode` 复用普通 Dev 的完整构建，然后用当前安装的 Electron
Node 模式预编译 `apps/zcode-cli/packages/cli/dist/zcode.cjs`，生成同目录的
`zcode.bytecode.cjs` 加载器、`zcode.bytecode-<sha256>.jsc` 和
`zcode.bytecode-runtime-<sha256>.cjs`。普通 `pnpm dev:desktop` 继续运行 JS，
用于同一版本、同一工作负载下的 A/B 比较。仅重新生成字节码可执行
`pnpm build:desktop-agent:bytecode`（先确保普通 CLI bundle 已更新）。

构建/字节码格式由 desktop 构建脚本持有；入口选择仍由既有 Agent command resolver
持有。Dev 启动器通过 `ZCODE_DESKTOP_AGENT_BYTECODE=1` 向 Host 传递选项；它只影响
Electron 内的工作区 CLI bundle，不影响显式 Agent command、SSH/WSL 的原生 Agent
或正式打包流程。该变量不是 CLI 的产品功能参数，完整约定见
[Agent Server spec](../../apps/zcode-cli/docs/design/v2/zcode-protocol-agent-server.md)。

```text
Dev 构建 → 普通 zcode.cjs → 匹配的 Electron Node 编译 → 字节码 + 加载器
Host command resolver → Electron Node 加载器 → 原 app-server --stdio
                                         └→ 原 session/queue/stream owner
Host storage Worker → 普通 zcode.cjs --prepare-storage → 原存储启动门禁
```

加载器必须在执行 CLI 前校验 Electron/Node/V8、平台、架构、V8 缓存标识及字节码摘要；
不匹配、缺失或缓存拒绝必须报错，不能静默回退 JS。预编译禁止执行用户 CLI；加载器
不向 stdout 打印诊断，不改变 argv、cwd、模块相对路径或 stdio 生命周期。
存储准备 Worker 保留 JS 入口，避免不同 Electron 进程类型的 snapshot 不兼容；桌面
continuous、手机 replayable 的 owner/恢复边界保持原约定。

此试验使用等长 ASCII 空格占位，并关闭懒编译和字节码回收，尚未移除 V8 的源码引用。
不承诺堆占用下降，也不作为源码加密方案；普通 JS 仍留在开发目录用于对照与存储准备。
验收需覆盖 CommonJS/动态 import、argv/资源路径、动态生成函数的 toString、错误路径、
运行时不匹配/损坏、真实 stdio 握手和 EOF。对比记录运行时、bundle 摘要、启动耗时、
GC 后 heapUsed 和 RSS；用户截图的 Strings 分类不能直接等同于源码占用。

## 默认行为

不传参数时，保持现有默认值：`mac` + `arm64`。

```bash
pnpm bundle:desktop
```

## 显式指定目标平台

命名参数：

```bash
pnpm bundle:desktop -- --os mac --arch x64
pnpm bundle:desktop -- --os win --arch x64
pnpm bundle:desktop -- --os linux --arch arm64
```

位置参数：

```bash
pnpm bundle:desktop -- win arm64
```

## 支持值

- `os`: `mac` / `win` / `linux`
- `arch`: `x64` / `arm64`

同时兼容常见别名：`macos`、`darwin`、`windows`、`amd64`、`aarch64`。

## CI / 脚本场景

如果不方便传 CLI 参数，也可以使用环境变量：

```bash
ZCODE_TARGET_OS=linux ZCODE_TARGET_ARCH=x64 pnpm bundle:desktop

正式发版打包不再注入可配置的 generic update feed。新版客户端运行时使用服务端 manifest provider；`electron-builder` 的 generic `publish.url` 只保留本地占位，真实更新检查接口由默认 endpoint 或 `ZCODE_UPDATE_FEED_URL` 覆盖。
```

## 预检查

如果只想确认最终会执行哪个目标组合，可以先跑 dry run：

```bash
pnpm bundle:desktop -- --os linux --arch x64 --dry-run
```

## CI 拆阶段打包

GitLab CI 里会先单独执行资源准备和桌面端 build，再调用 bundle 真正出安装包。
这时可以用下面两个参数跳过重复步骤：

```bash
pnpm bundle:desktop -- --os mac --arch arm64 --skip-prepare --skip-build
```

等价环境变量：

```bash
ZCODE_SKIP_PREPARE=1 ZCODE_SKIP_BUILD=1 pnpm bundle:desktop
```

## 生产产物安全收口

- `packages/desktop/scripts/run-production-build.mjs` 必须为 `tsup` 和 `vite build` 显式注入
  `NODE_ENV=production`。
- 生产构建开始前必须清理 `out/main`、`out/host`、`out/preload`、`out/renderer` 和 dev ready
  markers，但保留 `out/metadata`。原因是 tsup 不会自动删除旧 chunk，历史未压缩产物会被
  `electron-builder` 的 `out/**/*` 重新带入安装包。
- `packages/desktop/tsup.config.ts` 在生产态必须对 `main`、`host`、`preload` 三组 Node 产物开启
  `minify`，关闭 `sourcemap`，并设置 `legalComments: "none"`，避免发布包保留源码注释或
  `sourceMappingURL=*.map` 入口。
- `packages/desktop/electron-builder.config.js` 的 `afterPack` 需要继续清理最终资源里的 `*.map` 和
  JS/CSS `sourceMappingURL` 注释。原因是 electron-builder 的 `files` 裁剪只能覆盖主包文件，
  afterPack 运行时依赖注入、`app.asar.unpacked` 和 `extraResources` 仍可能重新带入第三方
  sourcemap 尾注。
- `packages/desktop/scripts/bundle.mjs` 的 `requiredRuntimeModules`（产物机械校验）必须是
  `packages/desktop/electron-builder.config.js` 的 `REQUIRED_ASAR_RUNTIME_MODULES`（afterPack 注入）
  的子集。原因是校验只判断模块在不在 app.asar 里，真正把依赖闭包补进产物的是 afterPack 注入；
  只加校验不加注入时，没有任何环节负责补齐该模块的子依赖，只能等打包末尾失败。
  注入名单按 `package.json` 依赖闭包递归展开，已在产物里的模块会被跳过，重复登记不会改变产物。
- 开发态仍保留 tsup sourcemap，方便本地调试 main/host/preload；生产态不生成也不暴露 sourcemap。
