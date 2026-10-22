# zcode-cua 并入 z-code monorepo

## 目标

`@zcode/zcode-cua`（CUA producer：MCP server、Helper runtime、`ax_native.node`、node_repl SDK、官方 Skill）从独立仓库 `git.example.invalid/codegeex/zcode-cua` 搬入 z-code 的 `packages/zcode-cua/`，成为普通 workspace 包：

- 消费方统一 `workspace:*`，不再有 git SHA pin，也不再需要 `ZCODE_CUA_GIT_TOKEN` 之类的私有仓库凭据。
- `dist/` 不入 git，由 `pnpm build:cua` 产出；根 `prepare` 与 CI 安装后自动构建。
- CUA 的单测、eval 与真机 e2e 纳入 z-code CI；z-code 桌面端打包直接使用 workspace 内构建产物。
- 许可跟随 z-code（Apache-2.0），TypeScript 等工具链对齐根仓库。

导入基线：`zcode-cua@4a3c507dd16f3ed840e87bc92e709ce339e6a4f3`（v0.6.4），以一个 squash 快照提交落地，提交尾注 `Imported-From` 记录来源。

## 目录

```
packages/zcode-cua/
  src/            TypeScript 源码（MCP server、broker、Helper、SDK）；src/native/ 为 ax_native N-API 源码
  binding.gyp     ax_native.node 构建描述
  test/           vitest 单测（root vitest 的 cua project）
  tests/          python unittest、parity fixtures（仅保留 <1MB 样本）
  evals/          zcode-gui-eval（独立 lockfile，不进 workspace）
  scripts/        build / native / live smoke / 真机 e2e gate
  plugin/         官方 Skill（SKILL.md）与 plugin.json 的唯一真相源
docs/cua/producer/ 对外有效的 CUA producer 文档
```

## 不随迁移搬入的内容

| 内容                                                                                             | 原因                                                  |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| `dist/`                                                                                          | 改为构建产物                                          |
| 独立仓库 CI（`.gitlab-ci*`、lore trailer、merge gate、AI review、dist freshness、package smoke） | 由 z-code CI 与 MR 规范替代                           |
| remote smoke（Linux/Windows 远端 act-verify、frame-pixel 远端门）                                | 依赖私有远端机器，非仓库内可复现验证                  |
| 大体积 parity fixture（≥1MB 的 11 组样本及其派生物）                                             | 仓库体积；oracle 同步裁剪，余下样本仍覆盖全部编码路径 |
| 内部过程文档（测试证据、计划、已知问题、CI 流程）                                                | 仅对原仓库维护过程有效                                |
| 原 MIT LICENSE、独立 lockfile                                                                    | 许可与依赖锁跟随 z-code                               |

## 版本与 pin

- CUA 版本号唯一真相源：`packages/zcode-cua/package.json` 的 `version`。构建期仍内联进 `SERVER_VERSION`。
- 删除 pin 工具链：`bump-zcode-cua-producer.mjs`、`check-cua-baseline.mjs`、`sync-skill-from-zcode-cua.mjs`、`upstream.json`。
- `check-version-coherence.mjs` 直接读取 workspace 包的 `package.json` 与 `plugin/`；插件侧 Skill 由 `packages/zcode-cua/plugin/` 同步，14 KiB 预算守卫保留。
- Windows Helper 产物名 `@zcode/zcode-cua-helper-runtime` 作为发布物名称保留，不再是 npm 依赖别名。

## 构建链路

```
pnpm install
  └─ zcode-cua install hook：node-gyp 编 ax_native.node（非 macOS/失败时 best-effort）
  └─ root prepare：husky && pnpm build:cua
        └─ tsc -b tsconfig.build.json && node scripts/build.mjs  → packages/zcode-cua/dist
消费方（desktop / services / cli adapters / core / node-repl-host / zcode-cua-plugin）
  └─ 通过 workspace 软链解析 @zcode/zcode-cua → dist/**
```

`typecheck`、`test:unit`、`dev:desktop`、`build:cua-helper` 以及 CI 安装步骤之后都依赖 `dist` 已存在。

eval 的依赖回归测试同时核对 CI 安装先于 evaluator 执行，以及根 `prepare` 调用 `build:cua` 并指向 workspace producer。CI 不再单独重复执行 `pnpm build:cua`，测试不能继续要求这条已移除的命令。

包内 lint 使用自带的 `packages/zcode-cua/.oxlintrc.json`（oxlint 默认规则，与原仓库一致），不继承根配置的 `max-lines`；根 `pnpm lint` 通过 `ignorePatterns` 跳过本包。

## CI

| job                  | 触发                                                                                    | 内容                                                                     |
| -------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `cua:unit:macos`     | MR 改动 `packages/zcode-cua/**`（经 `approve:merge-request` 放行）或 web/api 手动流水线 | install（根 prepare 构建 dist）→ typecheck + oxlint → vitest cua project |
| `cua:eval:macos`     | 同上                                                                                    | zcode-gui-eval 定义校验与 node test、全部 python unittest                |
| `cua:real-e2e:macos` | MR / web / api 下手动触发，失败不阻塞                                                   | 启动产品 broker，真机跑 CUA e2e gate                                     |
| Helper 构建/打包     | 原有规则                                                                                | producer SHA 取 `CI_COMMIT_SHA`，版本取 workspace 包                     |

Docker / Jenkins 不再改写 git URL、不再注入 zcode-cua 凭据（Jenkins `zcode-cua.gitlab-read` 可回收）：

- web-share：运行时与构建期都不涉及 CUA，镜像不含 git，也不复制 `packages/zcode-cua`。
- web-remote-control v4：把 `packages/zcode-cua` 放进构建上下文，`pnpm install --ignore-scripts` 后先 `pnpm build:cua` 再构建 Web。

两个镜像均以 `--ignore-scripts` 安装，天然跳过 native 编译。

## 验证

- `pnpm install` 后 `packages/zcode-cua/dist` 与 `ax_native.node` 存在。
- `pnpm typecheck`、`pnpm lint`、`pnpm test:unit`（含 cua project）、`pnpm verify:pre-push` 通过。
- `pnpm build:cua-helper` 能产出 Helper。
- `ZCODE_CUA_DEV_MODE=1 pnpm dev:desktop` 能拉起 Helper 并完成真实 CUA 调用。
