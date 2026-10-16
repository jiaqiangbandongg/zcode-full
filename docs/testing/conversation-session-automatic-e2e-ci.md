# Desktop Formal Manual E2E CI

## 背景

需要一个 CI 入口试跑已经完成 V4 formal admission 的桌面端 E2E，用于定位 MR/web pipeline 上的桌面端回归问题。该入口从 conversation-session 的 direct-root glob 收集正式 case，并显式列入已人工验证的跨域正式 spec；`manual-review/pending` 不会被非递归 glob 收入。

当前状态：手动可选。`test:e2e:conversation-session:auto` 和 `test:e2e:conversation-session:auto:windows` 在 `approve-mr` 阶段显示为 manual job；未点击不会阻塞 `build-app` / `build` 后续流程，点击后失败也按 `allow_failure=true` 处理。job 名称保留历史 conversation-session 命名，但覆盖范围已经包含已准入的桌面正式子集。

## 手动正式集合

`ZCODE_E2E_SPEC` 当前使用正式目录 glob：

```bash
./test/e2e/conversation-session/*.test.ts,
./test/e2e/plugins/*.test.ts,
./test/e2e/workspace-file-tree-refresh.test.ts
```

conversation-session glob 动态机械收集 direct-root formal spec，不用固定数量作为门禁。每个 spec 都必须先通过 formal admission audit：禁止旧 aggregate helper，必须具备 case manifest、case-local provider fixture，以及与 manifest 一致的请求 ledger。plugins glob 收集已转正插件域用例；`workspace-file-tree-refresh.test.ts` 是文件树域已转正的跨域正式用例：不触发 provider 请求，使用真实 workspace 文件 fixture 验证刷新按钮和 watcher 实时刷新链路。

CI 不再维护第二份 `ZCODE_E2E_EXCLUDE_SPEC` quarantine。formal 是否可收集由目录位置和 admission audit 共同决定；尚未满足合同的 case 留在 `manual-review/pending`，不能先放进 direct-root 再靠 CI 排除。

## 触发规则

- GitLab merge request pipeline 创建后显示 macOS / Windows 两个 manual e2e job；需要定位时再手动点击。
- GitLab Web UI 手动创建的 pipeline 中同样显示 manual e2e job，不会自动消耗 runner。
- 后续 `test` / `build-app` / `build` 等阶段不再依赖 desktop formal e2e；未点击、跳过或失败都不阻塞后续流程。
- `build:desktop:app` 只等待 `approve:merge-request` 人工确认；macOS / Windows / Linux 平台打包 job 只依赖 `build:desktop:app` 的 artifact。
- 目标分支范围沿用 workflow 规则：只为目标分支 `main` 或 `staging` 的 MR 创建 pipeline。

## 运行命令

CI job 使用 macOS shell runner 在宿主机上执行桌面端 WDIO Electron E2E：

```bash
E2E_PROVIDER_HTTP_MODE=replay \
ZCODE_E2E_SPEC='./test/e2e/conversation-session/*.test.ts,./test/e2e/workspace-file-tree-refresh.test.ts' \
pnpm --filter @zcode/e2e-report build:node

E2E_PROVIDER_HTTP_MODE=replay \
ZCODE_E2E_SPEC='./test/e2e/conversation-session/*.test.ts,./test/e2e/workspace-file-tree-refresh.test.ts' \
pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts
```

`ZCODE_E2E_SPEC` 只作为环境变量交给 `wdio.conf.ts` 解析。CI 不再把同一个 glob追加到 WDIO CLI `--spec`，避免出现两套 spec 过滤入口，让 job 只跑到 `onPrepare` / 构建阶段却没有稳定调度 worker。

普通 replay 会启动本地 provider fixture replay server，不访问真实模型上游，也不依赖 CI 里的 API key。该入口不启动 Docker。

## Windows 并行工具链隔离

Windows job 使用 GitLab `parallel` 生成四个独立 job。四个 job 不再使用 WDIO native
连续切片；启动 WDIO 前先展开同一份 formal glob，读取
`packages/desktop/test/e2e/conversation-ci-spec-duration-weights.json`，按历史 worker 耗时使用确定性 LPT
分配到四个桶，再由 `CI_NODE_INDEX` 选择当前桶并写回显式 `ZCODE_E2E_SPEC`。这样同时
平衡长 spec、单 spec 多 case 和新 spec fallback，不会因为文件名顺序让第一个 shard
长期承载 background/goal 等重型集合。每个 job 的 summary 只校验自己选中的显式子集；
分配器测试负责证明四桶并集等于全量 formal 集合、没有重复且估算耗时受控。
当前 profile 来自一次 78-spec、200-case 全量成功运行的 worker 生命周期耗时，新 spec
使用 20 秒 fallback。不同平台的绝对耗时可以整体缩放，LPT 只消费 spec 间相对权重；
后续拿到新的 Windows 全量成功产物后，可用同一 `worker` 时长口径刷新 profile。

同一份运行时样本按旧 native 连续切片和新 LPT 重新计算后的分布如下。耗时列是 profile
估算值，不冒充 Windows CI 的新实跑墙钟；它用于证明分配算法不再把重型 spec 固定压在首桶。

| 分配方式         | Shard case 数        | Shard 估算耗时                  | 最大/最小耗时比 |
| ---------------- | -------------------- | ------------------------------- | ---------------: |
| WDIO native slice | `88 / 45 / 39 / 28`  | `633s / 316s / 270s / 293s`     |             2.35 |
| historical LPT    | `52 / 55 / 41 / 52`  | `375s / 381s / 375s / 380s`     |             1.02 |

```text
formal glob -> expand -> historical duration profile -> LPT bucket 1..4
                                                     -> CI_NODE_INDEX
                                                     -> explicit ZCODE_E2E_SPEC
                                                     -> WDIO -> subset summary gate
```

四个 job 仍可能落在同一台 shell runner 主机。NVM 安装目录是机器级共享状态，job setup 禁止在其中重复创建或覆盖
Corepack 的 `pnpm.ps1`。每个 job 必须以 `CI_JOB_ID` 在项目临时目录下创建独立的 Corepack
shim 目录，把该目录放到当前进程 `PATH` 首位，并在运行 pnpm 前机械校验实际命令来自该目录。

```text
Windows runner
  ├─ job A -> .tmp/corepack-<job-A>/bin/pnpm.ps1 -> weighted bucket 1
  └─ job B -> .tmp/corepack-<job-B>/bin/pnpm.ps1 -> weighted bucket 2

禁止：job A/B -> NVM_HOME/<node-version>/pnpm.ps1（共享覆写）
```

若当前进程的 Node 版本已经满足 `NODE_VERSION`，setup 不再调用会切换机器级 symlink 的
`nvm use`；只有版本不匹配时才走既有 use/install/use 恢复链。Corepack shim 隔离只改变
CI 工具启动路径，不改变 pnpm store、workspace、E2E HOME、artifact 或 native shard 范围。

## SSH remote assets 自动准备

conversation formal glob 包含 `conversation-session-ssh-remote*.test.ts`。当 runner 配置了
`ZCODE_E2E_SSH_HOST` + `ZCODE_E2E_SSH_USERNAME` + `ZCODE_E2E_SSH_PASSWORD`（或任一
`ZCODE_E2E_SSH_HOST` / `ZCODE_E2E_SSH_A_HOST` / `ZCODE_E2E_SSH_B_HOST`）时，WDIO `onPrepare`
的 `stageDesktopE2EAppOutput` 会把 `packages/desktop/mock-cdn/releases/<repo version>`
stage 到 runId 隔离目录，供 SSH remote runtime 使用。

该 release 目录由 `pnpm --filter @zcode/desktop prepare:remote-assets` 产出。历史上的坑：
CI 只有 `build:remote:assets` job 会跑该命令，且它跑在 `macos` tag runner 的工作槽位，
而 conversation e2e 跑在专用 e2e runner；`mock-cdn` 虽被 `GIT_CLEAN_FLAGS` 排除做工作区
持久化，但两个工作目录互不相通，且目录按版本号命名——每次版本 bump 后专用 runner 上
必然缺新版本目录，`onPrepare` 直接 fatal（2026-09-11 MR 2606 的
`SSH remote assets missing: .../mock-cdn/releases/3.12.0` 即此问题）。

当前行为：SSH 环境就绪但 release 目录缺失时，`onPrepare` 自动执行
`pnpm --filter @zcode/desktop prepare:remote-assets` 再 stage；目录已存在则跳过（幂等，
同版本复用持久化产物）。prepare 完成后目录仍缺失则继续 fail-closed 中止运行。这样
conversation e2e job 与本地 SSH e2e 都不再依赖其他 job / 其他 runner 槽位的工作区
隐式共享产物。

```text
wdio onPrepare (stageDesktopE2EAppOutput)
  └─ SSH env 就绪?
       ├─ 否 → 跳过 remote release stage
       └─ 是 → mock-cdn/releases/<version> 存在?
              ├─ 是 → stage 到 runId 隔离目录
              └─ 否 → 自动跑 prepare:remote-assets
                       ├─ 产出成功 → stage
                       └─ 仍缺失 → fail-closed fatal
```

## Artifact

每次手动运行固定写入 `packages/desktop/.e2e-artifacts/<run-id>/`，并作为 GitLab job artifact 保留。核心文件包括：

- `summary.md`
- `summary.json`
- `test-results.ndjson`
- `ci-pnpm-install.log`
- `ci-electron-install.log`
- `ci-desktop-e2e.log`
- `perf/container-samples.ndjson`
- `network-capture/`

## CI stdout

该 job 默认设置 `ZCODE_E2E_CI_STDOUT_MODE=summary`。在这个模式下，依赖安装、Electron binary 修复和 WDIO E2E 的完整 stdout/stderr 都写入 artifact 文件，GitLab 控制台只打印：

- 当前步骤的日志文件路径
- E2E 结束后的 run id、exit code、耗时、通过/失败数量
- 失败 case 的标题和错误摘要
- 未能生成 `summary.json` 时的尾部日志

这样可以避免 WDIO / Electron / app-server 的高频日志把 GitLab job stdout 打爆，同时仍保留完整排查材料。

需要临时看实时输出时，可以在 Web pipeline 里把 `ZCODE_E2E_CI_STDOUT_MODE` 覆盖为 `verbose`。

## 边界

- 当前手动入口动态覆盖桌面端 `desktop-continuous` conversation direct-root admitted formal spec、插件域正式 spec，以及文件树刷新这类不依赖 provider 的已转正桌面 UI case。
- `manual-review/pending` 不进入该入口；formal admission audit 失败会在机械门禁中阻止错误转正。
- 历史 `conversation-session-admission`、`conversation-session-needs-docker-fix` 和 `conversation-session-tool-cross-product` Docker preset 已退出当前配置，不能作为 V4 formal 准入事实。
- Docker `replay-isolated` 仍保留给正式 Docker 准入和容器环境定位；本入口只跑普通 replay。
- 手机 `/remote` 的 `web-remote-replayable` 恢复语义继续走远控专项回归，不由本 job 证明。
