# Desktop Bundle Size Architecture

桌面端打包现在改成“两套资源明确分层”：

- desktop 本地 agent 运行时按当前平台准备后进入安装包
- remote 专用资源由 `@zcode/server-cli stage:remote-assets` 产出到 `mock-cdn/releases/...`，不再进入安装包

## 目录约定

- `packages/desktop/bundled-agents/<platform>/`
  - 当前目标平台的最小运行时目录
  - 当前产品路径只要求 `glm/`
  - 同目录下会生成 `*-<platform>.tgz` 归档，便于审计和后续远程分发复用
- `packages/desktop/mock-cdn/`
  - 开发态 remote 资源入口
  - 统一按 `releases/<version>/...` 保存 `source-server-release.json` 与四个平台 Source Server archive

## 生产态

- 生产安装包不再包含 `remote-assets`
- 生产态 remote 资源通过 CDN 版本根的 `source-server-release.json` 与 `zcode-server-<platform-arch>.tar.gz` 分发
- 首次安装或显式更新时按 descriptor 校验 SHA-256/大小；本地下载模式缓存完整 archive 后上传，SSH 远端下载模式在目标机下载同一 archive，最终都进入 immutable release installer
- `ZCODE_ENV=production` 时默认内置两组官方 CDN：
  - 国内：`https://cdn.codegeex.cn/zcode/electron/releases/<version>`
  - 海外：`https://cdn-zcode.z.ai/zcode/electron/releases/<version>`
- CI 若配置 `CDN_DOMAIN` / `OSS_PATH_PREFIX`，生产包会在构建期把这些变量展开为 remote CDN 候选列表。
  `CDN_DOMAIN` 的仓库默认值统一为 `cdn-zcode.z.ai`，覆盖 CI 全局变量、CDN URL 前缀校验、OSS 上传 URL 生成和 CDN 预热脚本；默认发布路径仍为 `zcode/electron/releases`。显式配置单域名或多域名列表时，继续按配置顺序解析 bucket、路径和预热账号。
  迁移期可使用逗号列表让 `3.1.3` 优先新 CDN、保留旧 CDN 兜底；切换完成后把 CI 变量收敛为单个新 CDN 即可。
- 默认优先级按“应用语言 + 本地时区”决定：
  - `locale` 为中文，且时区处于 UTC+8：优先国内 CDN，海外 CDN 作为备选
  - 其他情况：优先海外 CDN，国内 CDN 作为备选
- 如果构建期注入了 `CDN_DOMAIN` 列表，则按 CI 列表顺序使用，不再按语言/时区重排。
- `ZCODE_ENV=test` 时默认使用内网测试资源根：
  `http://intranet.example.invalid:12345/ssh-remote-assets/<version>`。该目录由 CI 的
  `build:remote:assets` job 同步 descriptor 与四个 archive。
- `remoteCdnBaseUrl` 仍可通过环境变量覆盖；一旦显式设置，就只使用该自定义基址，不再套用
  `ZCODE_ENV` 默认值或 production 地区分流
- SSH 远端服务器下载模式会在远端临时目录下载并校验完整 archive；最终安装到 `~/.zcode/server/releases/`，并通过 `current.json` 原子切换。

## 开发态切换公网 CDN

- 开发态默认使用本轮 Source Server staging 写入的 `mock-cdn/releases/<version>/...`
- 若要在开发态强制走公网 CDN，可设置环境变量：`ZCODE_DEV_REMOTE_ASSET_USE_CDN=1`
- 开启后，remote deploy 不再读取 `mock-cdn`，会直接进入 descriptor/CDN + 本地 archive cache 链路
- 未设置 `ZCODE_REMOTE_ASSET_CDN_BASE_URL` 时，仍按上面的地区分流规则生成“主 CDN + 备选 CDN”候选列表
- 可配合 `ZCODE_REMOTE_ASSET_CDN_BASE_URL` 指向自定义 CDN 基址
- 可设置 `ZCODE_REMOTE_ASSET_CACHE_DIR` 覆盖 remote cache 目录；例如 dev 启动时指向正式版 `~/Library/Application Support/ZCode/remote-assets-cache`，只复用 remote 资源缓存，不切换 Electron `userData`
- 上述 remote asset 环境变量可从 shell 传入，也可写在仓库根目录或 `packages/desktop` 下的 `.env.local`；shell 环境变量优先级更高
- 若要一键启动“desktop dev + 生产态 remote SSH 下载/cache 链路”，使用 `pnpm dev:desktop:remote-prod`

## Source Server 准备链路

1. `@zcode/server-cli stage:remote-assets` 构建 Server CLI/Core 与 Agent bundle。
2. 按 linux/darwin × x64/arm64 收集目标 Node、node-pty、官方插件和 native tools。
3. 每个平台生成一个完整 archive，并写入统一 `source-server-release.json`。
4. 开发态与生产态使用同一 archive 安装合同，不再生成散组件、wrapper 或 legacy manifest。

桌面侧与 remote 侧共用同一份编译后的 `zcode.cjs`，不再按平台下载内嵌 Node 的原生 `zcode-agent`：

- `scripts/build-desktop-agent-cli.mjs` 构建 `apps/zcode-cli/packages/cli/dist/zcode.cjs`，并构建、校验 node-repl-host、Browser Use client 和模拟器等 Dev 必需的官方插件 runtime。`pnpm dev:desktop` 在 `pre-dev` 后执行该脚本，开发态 resolver 优先直接使用 workspace 内的 bundle；`stage:remote-assets` 也通过它取得 Agent bundle。
- 桌面打包的 `prepare:agent-bundle` 将 `zcode.cjs` 和官方插件 seed 资源写入 `packages/desktop/bundled-agents/<platform>/glm/`，再由 electron-builder 复制到安装包。
- `scripts/download-glm.mjs` 与 desktop `prepare:glm` 仅保留为手动兼容兜底，不进入默认 Dev、桌面打包或 remote 资产准备链路。

## 哪些资源禁止进入安装包

- 本地 agent 目录里的非当前目标平台 native
- `node_modules` 里的非当前目标平台 native package / prebuild
- renderer 已经完成 bundle、桌面 Node runtime 不会加载的 optional native dependency；当前包括
  `pdfjs-dist` 为 Node 环境声明的 `@napi-rs/canvas*`
- `node-pty/build`、`node-pty/bin` 和非当前目标平台的 `node-pty/prebuilds/<platform-arch>`；桌面包
  只保留 `node-pty/prebuilds/<target-platform-arch>`
- 仅用于准备目标 prebuild 的 `@lydell/node-pty-*` 包；Linux 打包在 `beforePack` 将目标二进制复制到
  `node-pty/prebuilds/<target-platform-arch>` 后也必须排除这些源包
- `mock-cdn/`
- `*.map`
- `*.pdb`
- `*.tgz`
- `*.tsbuildinfo`
- `docs/`、`doc/`、`man/`
- `example/`、`examples/`
- `test/`、`tests/`、`__tests__/`
- 非许可证 markdown

## 审计

`packages/desktop/scripts/audit-bundle-size.mjs` 会在 macOS bundle 后自动执行，校验：

- `.app` 总大小
- `Resources/*` 目录体积
- `Frameworks/*` 目录体积
- 前 30 个最大资源项

超过阈值会直接失败，避免包体回涨。

除安装文件大小阈值外，`electron-builder` 的 `afterPack` 和 bundle 完成后的机械审计还必须校验：

- 安装包中不存在 `@napi-rs/canvas*` 和 `@lydell/node-pty-*`
- `node-pty` 只包含当前 `targetPlatform.key` 对应的 prebuild，不包含安装机或其他目标平台产物
- `.node`、`.dll`、`.dylib`、原生辅助 `.exe` 以及 node-pty 的无扩展名 helper 在 asar header 中
  标记为 unpack，不得同时作为 packed payload 留在 `app.asar` 并在 `app.asar.unpacked` 再保留一份

asar 内容审计必须由 Node 直接调用项目锁定版本的 `@electron/asar` CLI。禁止通过 `pnpm exec asar`
获取待解析输出，避免 workspace engine warning 等 pnpm 诊断信息混入 stdout 后被误判为 asar 条目。

`pnpm-workspace.yaml#supportedArchitectures` 只控制工作区安装阶段允许准备哪些平台依赖，不能作为安装包
资源边界。最终安装包资源集合必须由 `ZCODE_TARGET_OS` / `ZCODE_TARGET_ARCH` 决定。
