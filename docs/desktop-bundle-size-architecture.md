# Desktop Bundle Size Architecture

桌面端打包现在改成“两套资源明确分层”：

- desktop 本地 agent 运行时按当前平台准备后进入安装包
- remote 专用资源只产出到 `mock-cdn/releases/...`，不再进入安装包

## 目录约定

- `packages/desktop/bundled-agents/<platform>/`
  - 当前目标平台的最小运行时目录
  - 当前产品路径只要求 `glm/`
  - 同目录下会生成 `*-<platform>.tgz` 归档，便于审计和后续远程分发复用
- `packages/desktop/mock-cdn/`
  - 开发态 remote 资源入口
  - 统一按 `releases/<version>/...` 布局保存 `node`、`server`、`node-pty`、`glm`、`tools`

## 生产态

- 生产安装包不再包含 `remote-assets`
- 生产态 remote 资源通过 CDN 的 `manifest-<platform-arch>.json` 与跨版本 `components/...` 分发
- 首次 remote 连接时会按 manifest 下载缺失组件，解压到本地 component cache，并组装到 `remoteCacheDir/releases/<version>/<platform-arch>/`；后续命中缓存不重复下载
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
  `build:remote:assets` job 在测试环境构建时从 `mock-cdn/releases/<version>/manifest-*.json`
  与 `mock-cdn/components/` 同步生成，目录下直接包含 `manifest-*.json` 和 `components/`。
- `remoteCdnBaseUrl` 仍可通过环境变量覆盖；一旦显式设置，就只使用该自定义基址，不再套用
  `ZCODE_ENV` 默认值或 production 地区分流
- SSH 远端服务器下载模式会在远端 `~/.zcode/server/asset-cache/` 下缓存已校验并解压的组件；最终安装路径仍是 `~/.zcode/server/` 下的现有 runtime、server、agent 和 tools 目录。

## 开发态切换公网 CDN

- 开发态默认仍使用 `mock-cdn/releases/<version>/...`
- 若要在开发态强制走公网 CDN，可设置环境变量：`ZCODE_DEV_REMOTE_ASSET_USE_CDN=1`
- 开启后，remote deploy 不再读取 `mock-cdn`，会直接进入 CDN 下载 + 本地缓存链路
- 未设置 `ZCODE_REMOTE_ASSET_CDN_BASE_URL` 时，仍按上面的地区分流规则生成“主 CDN + 备选 CDN”候选列表
- 可配合 `ZCODE_REMOTE_ASSET_CDN_BASE_URL` 指向自定义 CDN 基址
- 可设置 `ZCODE_REMOTE_ASSET_CACHE_DIR` 覆盖 remote cache 目录；例如 dev 启动时指向正式版 `~/Library/Application Support/ZCode/remote-assets-cache`，只复用 remote 资源缓存，不切换 Electron `userData`
- 上述 remote asset 环境变量可从 shell 传入，也可写在仓库根目录或 `packages/desktop` 下的 `.env.local`；shell 环境变量优先级更高
- 若要一键启动“desktop dev + 生产态 remote SSH 下载/cache 链路”，使用 `pnpm dev:desktop:remote-prod`

## agent 准备链路

当前 desktop 与 remote 默认都使用编译后的 `zcode.cjs`，不再按平台下载内嵌 Node 的原生
`zcode-agent`：

1. `scripts/build-desktop-agent-cli.mjs` 构建 `apps/zcode-cli/packages/cli/dist/zcode.cjs`，并构建、校验
   CUA 等 Dev 必需的官方插件 runtime。`pnpm dev:desktop` 在 `pre-dev` 后执行该脚本，开发态 resolver
   优先直接使用 workspace 内的 bundle。
2. 桌面打包的 `prepare:agent-bundle` 将 `zcode.cjs` 和官方插件 seed 资源写入
   `packages/desktop/bundled-agents/<platform>/glm/`，再由 electron-builder 复制到安装包。
3. remote 资产的 `prepare-prebuilds.mjs` 复用同一份 `zcode.cjs`，写入各平台
   `packages/desktop/mock-cdn/releases/<version>/glm/<platform>/` 后产出 component artifact；远端使用已部署的
   Node 执行该 bundle。

`scripts/download-glm.mjs` 与 desktop `prepare:glm` 仅保留为手动兼容兜底，不进入默认 Dev、桌面打包或
remote 资产准备链路。

这样做的原因：

- release generator 不再准备三方 agent runtime
- 让 desktop、web、remote deploy 都消费同一份 ZCode Agent 资源结构
- 避免把开发态 `node_modules`、跨平台 native、调试符号和缓存直接带进安装包

### 开发态 SSH agent 覆盖

`pnpm dev:desktop` 会先构建 `apps/zcode-cli/packages/cli/dist/zcode.cjs`。在
本地开发运行且该文件存在时，SSH remote deploy 的 `glm` 组件不再使用
mock-cdn / CDN 里的 `zcode-agent` native binary，而是把本地 `zcode.cjs` 上传到远端
`~/.zcode/server/agents/glm/zcode.cjs`，并生成一个可执行的
`~/.zcode/server/agents/glm/zcode-agent` wrapper。wrapper 使用远端已部署的
`~/.zcode/server/node` 启动这份 bundle，因此 agent 仍运行在目标 SSH 机器内，文件、
Git、terminal cwd 都保持远端语义。

远端同时写入 `.dev-version` 内容 hash；只有该标记匹配、必要资源完整且远端
`zcode.cjs` 的实际 SHA-256 与本地一致时才跳过重复上传。发布包或另一客户端覆盖
bundle 但残留开发标记时，必须重新上传；无法校验实际内容也按需重新部署。
生产态不启用该覆盖，仍严格使用 manifest/component 资源。开发时如需临时关闭覆盖，可设置
`ZCODE_REMOTE_DEV_AGENT_BUNDLE=0`。

## 哪些资源允许跨平台但禁止进包

- `mock-cdn/releases/<version>/node-pty/linux-x64`
- `mock-cdn/releases/<version>/node-pty/linux-arm64`
- `mock-cdn/releases/<version>/glm/<platform>/`
- `mock-cdn/releases/<version>/tools/<platform>/ripgrep/`

这些目录是 remote 功能专用入口，可以按远程目标平台保留多份，但不应再被 electron-builder 复制进 `.app`。

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
