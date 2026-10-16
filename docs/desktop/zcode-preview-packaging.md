# ZCode Preview 内部测试包

## Feature Summary

| Field                 | Value                                                                                                                                                                                                                   |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Change                | `ZCODE_ENV=test` 的全平台桌面安装包使用 `ZCode Preview` 产品身份，并可从 MR 流水线手动触发生产级构建、签名和公证链路                                                                                                    |
| User-visible surfaces | 安装包名、应用名、系统安装记录、任务栏/Dock、About、CUA 权限引导                                                                                                                                                        |
| Existing docs         | `docs/cua-permission-broker/zcode-cua-permission-broker.md`、`docs/cua-permission-broker/cua-helper-installation.md`、`docs/desktop/auto-update-superseded-ready-package.md`                                            |
| Existing code owners  | `packages/desktop/electron-builder.config.js`、`packages/desktop/src/main/desktopRuntimeEnv.ts`、`packages/desktop/src/main/autoUpdater.ts`、`packages/services/src/cua-permission-broker/*`、`.gitlab/ci/30-build.yml` |
| Out of scope          | 独立账号/任务/配置目录、独立协议 scheme、Preview 自动更新、生产与 Preview 同时执行 CUA 输入                                                                                                                             |

## Clarification Log

| Round | Question | User answer | Boundary fixed | Follow-up needed |
| --- | --- | --- | --- | --- |
| 1 | 测试包名称 | `ZCode Preview` | `ZCODE_ENV=test` 对应 Preview 产品名 | no |
| 1 | 数据和账号是否隔离 | 不隔离，与生产版相同 | 继续共享 `${ZCODE_HOME:-$HOME/.zcode}` 业务数据 | no |
| 1 | 是否独立更新/发布 | 不独立、不自动更新、仅内部 | Preview 不进入 stable 发布，不初始化更新器，也不执行强更 | no |
| 1 | 平台与能力范围 | 全平台、完整可用 | macOS、Windows、Linux 都生成可安装 Preview 包；生产已有的签名能力继续适用 | no |
| 2 | 是否要求与生产版同时运行 | 是 | OS 安装身份、可执行名和 Electron 运行目录必须分离 | no |
| 2 | deep link 冲突是否接受 | 接受 | 继续共用 `zcode://`，由系统当前默认 handler 接收 | no |
| 3 | 两个应用是否会同时使用 CUA | 不会，任一时刻只有一个使用 | 不增加跨应用 CUA 操作锁；只保证两边分别可用 | no |
| 4 | Preview 如何触发 | 与 MR merge/approve 同级的手动命令 | MR 流水线展示 `build:preview`；点击后启动同 commit 的独立 Preview 子流水线 | no |
| 5 | Preview 是否改变打包流程 | 不改变；与 MR production 使用同一套 build DAG，只改少数环境变量 | trigger 只向 child 显式传递 `ZCODE_PREVIEW_PIPELINE`、`ZCODE_ENV`、`TARGET_OUTPUT_DIR`；child 自己解析 runner/job 变量 | no |
| 6 | 手动创建的 test pipeline 如何隔离产物 | `ZCODE_ENV=test` 时统一写入顶层 `@electron-preview/<branch>/` | MR、GitLab Run pipeline、Pipeline Trigger API、普通 API pipeline 与 Preview child 使用相同 Preview 根目录；production、tag、`ci/*` 路径不变 | no |
| 7 | Pipeline Trigger API 是否支持平台裁剪 | 支持 | `CI_PIPELINE_SOURCE=trigger` 进入与 web/API 相同的 workflow，并消费 `ZCODE_BUILD_PLATFORMS`；未传平台变量时仍全平台自动 | no |

## Boundary Decisions

| Boundary | Decision | Includes | Excludes / prunes | Source |
| --- | --- | --- | --- | --- |
| 包类型 | `ZCODE_ENV=test` 构建 Preview | 生产优化、测试环境 API、内部安装包 | 新增第三种环境值 | user + current CI |
| 展示身份 | `ZCode Preview` | macOS bundle 名、Windows 产品名、Linux desktop 名、产物名 | 改图标或 UI 品牌体系 | user |
| 系统身份 | Preview 使用独立 app id / executable / Linux package name | 与生产版并排安装和启动 | 复用 `dev.zcode.app` | simultaneous-run invariant |
| 数据 | 业务数据继续使用 `~/.zcode` | 任务、配置、凭据 | 两个进程同时修改同一任务的强一致保证 | user |
| Electron 运行数据 | 按应用名分目录 | Chromium session、single-instance lock、cache | 与生产版共用 Electron `userData` | simultaneous-run invariant |
| Deep link | 继续使用 `zcode://` | OAuth、支付、打开工作区 | 确定投递到发起回调的应用 | accepted limitation |
| 更新 | Preview 完全禁用 | 后台轮询、手动检查入口、强更 gate | Preview update feed/channel | user |
| CUA 权限主体 | 两个主应用都可启动同一个签名身份的 Helper | Helper launcher app-id allowlist、同一 TCC 授权身份 | 同时执行两路鼠标键盘输入 | user + CUA architecture |
| CUA 安装 | Preview 使用 `computer-use/preview` 子目录 | 避免不同 App 版本互相升级/降级 Helper | 隔离任务、配置、凭据 | version-safety invariant |
| 签名 | Preview 使用生产签名逻辑并 fail-closed | macOS Developer ID + notarization、Windows vsigntool | 无凭据时静默生成未签名 Preview | user |
| CI 入口 | MR `approve-mr` 阶段增加可选 `build:preview` 手动 job | 触发同 MR commit 的 child pipeline，固定 `ZCODE_ENV=test` | 非 MR 展示入口、阻塞正常 MR 生产包构建 | user |
| CI 产物 | Preview 使用独立共享目录 | `@electron-preview/<branch>/`；MR/Preview child 使用 source branch，web/API 使用 ref name | 覆盖 `@electron/dev/...` 生产验收包 | artifact isolation invariant |
| CI 职责 | Preview child 只复用 build + notify | desktop app、全平台安装包、CUA Helper、remote assets、飞书产物通知 | test、upload/preload/publish/release | internal package boundary |
| CI 变量继承 | `build:preview` 不继承 parent 顶层默认变量 | 只转发三个 Preview 控制变量；签名凭据由同项目 child workflow 重新映射 | 转发依赖 parent runner 的 `CI_PROJECT_DIR` 派生目录 | GitLab variable phase boundary |

## Domain Scope

| Domain                       | Include? | Why it can change behavior                                                  | Primary sources                                                                                                                        |
| ---------------------------- | -------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop lifecycle/release    | yes      | 产品名、app id、single-instance、更新器、平台安装格式和手动构建入口均在此域 | `packages/desktop/electron-builder.config.js`、`.gitlab/ci/00-workflow.yml`、`.gitlab/ci/preview-child.yml`、`.gitlab/ci/30-build.yml` |
| Permission/tool/CUA          | yes      | Preview 的新 app id 必须被 Helper 以同 Team 的签名 requirement 接受         | `docs/cua-permission-broker/zcode-cua-permission-broker.md`                                                                            |
| Persistence                  | yes      | 业务数据共享，但 Electron `userData` 必须分开才能并行运行                   | `packages/desktop/src/main/desktopRuntimeEnv.ts`、`packages/services/src/paths.ts`                                                     |
| OAuth/deep link              | yes      | 两个安装包共用 scheme，系统只保留一个默认 handler                           | `packages/desktop/src/main/desktopOAuthDeepLink.ts`                                                                                    |
| Conversation/mobile realtime | no       | 不改变 Host/CLI 协议、workspace identity 或 delivery kind                   | architecture invariant                                                                                                                 |

## High-Risk Cross-Products

| Cross-product                               | Candidate risk                                                                                                        | Initial handling                                                                  |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Preview identity × OS installer             | 同 app id/package/executable 会覆盖生产版或命中同一实例锁                                                             | 独立系统身份，accepted                                                            |
| Preview × shared business data              | 两个进程同时修改同一设置/任务可能竞争                                                                                 | 用户确认共享；不承诺同一任务并发写，accepted limitation                           |
| Preview app id × CUA launcher verification  | Helper 当前只接受 `dev.zcode.app`                                                                                     | 同 Team 的显式双 app-id allowlist，accepted                                       |
| Preview version × production Helper version | 共用 Helper 路径会产生升级/降级冲突                                                                                   | Preview 使用 `computer-use/preview`，accepted                                     |
| Preview × auto/force update                 | 误读 stable feed 会覆盖 Preview 或阻止启动                                                                            | Preview 禁用所有 updater/force-update 入口，accepted                              |
| Prod + Preview × `zcode://`                 | 回调可能进入另一应用，OAuth state 不匹配                                                                              | 用户接受，ignored                                                                 |
| Preview trigger × MR production DAG         | 新手动 job 若是 blocking，会让未打 Preview 的 MR 无法正常完成                                                         | job 保持 optional；只有点击后才启动 child pipeline，accepted                      |
| Preview child × release jobs                | 复用根配置会误上传或覆盖 stable feed                                                                                  | child 只 include build/notify 分片，accepted                                      |
| Parent default variables × child runner     | `ZCODE_CI_TMPDIR="$CI_PROJECT_DIR/.tmp"` 在无 runner 的 trigger 阶段可能退化成 `/.tmp`，并以高优先级覆盖 child 默认值 | trigger 禁止继承 parent defaults，child job 使用自己的 `CI_PROJECT_DIR`，accepted |

## Concept Map

```text
ZCODE_ENV=test
  |
  +-- MR pipeline: build:preview (optional manual)
  |     -> child pipeline: same MR ref/SHA
  |     -> @electron-preview/<source-branch>/
  |     `-- build + sign + notarize + notify only
  |
  `-- MR / Run pipeline / Trigger API / API pipeline 显式传入 test
        `-- workflow 在 job graph 创建时选择 @electron-preview/<branch>/
  -> build identity: ZCode Preview / dev.zcode.app.preview / zcode-preview
  -> compiled runtime environment: test endpoints
  -> Electron runtime name: ZCode Preview
       -> appData/ZCode Preview (single-instance/session/cache isolation)
  -> business data: ${ZCODE_HOME:-$HOME/.zcode} (shared)
  -> updater: disabled
  -> CUA install: ~/.zcode/computer-use/preview/ZCode Computer Use.app
       -> signed helper identity remains dev.zcode.cua-helper
       -> trusted launcher is prod OR preview app id, same Team pin
```

```text
MR parent pipeline (same source commit)
  |
  +-- approve:merge-request [manual, blocking]
  |     `-- production build DAG -> @electron/dev/<source-branch>/
  |
  `-- build:preview [manual, optional]
        |   forwarded: ZCODE_PREVIEW_PIPELINE / ZCODE_ENV / TARGET_OUTPUT_DIR only
        `-- Preview child pipeline [ZCODE_ENV=test]
              +-- resolve CI_PROJECT_DIR/cache paths in each child runner job
              +-- build:desktop:app
              +-- macOS + Computer Use Helper (sign + notarize)
              +-- Windows + Linux + remote assets
              `-- artifact notifications

Preview child excludes: tests, upload, preload, publish, release
```

```text
workflow path selection
  |
  +-- MR + ZCODE_ENV=test      -> @electron-preview/<source-branch>/
  +-- web/api/trigger + ZCODE_ENV=test -> @electron-preview/<ref-name>/
  +-- MR/web/api/trigger production    -> @electron/dev/<branch>/
  `-- tag / ci/*               -> existing @electron/release or @electron/ci path
```

## State Owners

| State / fact              | Authority                                     | Mirrors / caches                                    | Evidence                                       |
| ------------------------- | --------------------------------------------- | --------------------------------------------------- | ---------------------------------------------- |
| Build flavor              | CI/build `ZCODE_ENV`                          | tsup/vite define、electron-builder config           | dry-run/config tests、产物 metadata            |
| OS application identity   | electron-builder config                       | macOS Info.plist、NSIS GUID、Linux package metadata | unpacked artifact inspection                   |
| Electron runtime identity | desktop main                                  | `app.name`、`userData`、single-instance lock        | runtime unit test、manual simultaneous launch  |
| Business data root        | services path resolver                        | settings/task/credential repos                      | path assertions、manual shared-task visibility |
| Update eligibility        | compiled `ZCODE_ENV` in desktop main          | application menu/tray/updater state                 | unit tests、network/log absence                |
| CUA launcher trust        | signed Helper process                         | code requirement string                             | peer-verifier unit test、signed macOS smoke    |
| CUA Helper version path   | Host process env + installer resolver         | helper candidate/reaper paths                       | installer/host unit tests、filesystem path     |
| Preview trigger variables | `build:preview` job                           | child pipeline trigger variables                    | CI config assertion                            |
| Child runtime paths       | child runner job 的 `CI_PROJECT_DIR` / `$PWD` | `ZCODE_CI_TMPDIR`、npm/electron cache paths         | runner log 中路径位于 checkout，不是 `/.*`     |

## Dimensions

| Dimension                 | Values / equivalence classes                                        | Source                   | Include?            | Reason                                                        |
| ------------------------- | ------------------------------------------------------------------- | ------------------------ | ------------------- | ------------------------------------------------------------- |
| Product environment       | production / test                                                   | CI + shared env          | yes                 | identity、endpoint、update policy differ                      |
| Platform                  | macOS / Windows / Linux                                             | packaging targets        | yes                 | installation identity mechanics differ                        |
| Concurrent installed apps | prod only / preview only / both                                     | user boundary            | yes                 | main purpose of separate identity                             |
| CUA launcher              | prod / preview / unrelated signed app                               | security requirement     | yes                 | first two accepted, unrelated must fail                       |
| CUA use                   | one active / two active                                             | user boundary            | representative only | two active pruned by product usage assumption                 |
| Deep-link receiver        | prod / preview                                                      | OS global scheme handler | yes                 | both valid but nondeterministic                               |
| Update trigger            | startup / poll / menu / force gate                                  | updater code             | yes                 | all must be disabled in Preview                               |
| Business data             | default shared root / explicit custom root                          | services paths           | representative      | identity change must not rewrite data root                    |
| CI pipeline               | MR parent / Preview child / tag release                             | GitLab workflow          | yes                 | Preview entry and release isolation depend on pipeline source |
| Preview command           | not clicked / running / succeeded / failed                          | manual trigger           | representative      | not clicked must not block production MR DAG                  |
| Trigger variable class    | explicit Preview controls / parent defaults / child job-only values | GitLab variable phases   | yes                 | only explicit controls may cross the parent-child boundary    |

## Candidate Combinations

| Candidate ID | State                                            | Event                             | Target/surface           | Expected guard/effect                                                                            | Initial status | Notes                                                |
| ------------ | ------------------------------------------------ | --------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------ | -------------- | ---------------------------------------------------- |
| ZPREVIEW-001 | `ZCODE_ENV=test`                                 | package                           | all platforms            | Preview name and distinct install identity; optimized build                                      | accepted       | primary build case                                   |
| ZPREVIEW-002 | production                                       | package                           | all platforms            | existing ZCode identity unchanged                                                                | accepted       | regression case                                      |
| ZPREVIEW-003 | prod and Preview installed                       | launch both                       | desktop lifecycle        | both instances remain running with separate Electron data                                        | accepted       | manual smoke                                         |
| ZPREVIEW-004 | Preview running                                  | read tasks/settings/credentials   | business data            | same `~/.zcode` repositories as production                                                       | accepted       | no data migration                                    |
| ZPREVIEW-005 | Preview packaged                                 | startup/menu/force config         | updater                  | no update check, no update UI, no force-update block                                             | accepted       | no auto update                                       |
| ZPREVIEW-006 | signed Preview                                   | start CUA                         | macOS Helper             | launcher passes Preview app-id + Team requirement                                                | accepted       | permission remains Helper-owned                      |
| ZPREVIEW-007 | signed production                                | start CUA                         | macOS Helper             | production launcher continues to pass                                                            | accepted       | regression case                                      |
| ZPREVIEW-008 | unrelated signed app                             | forge launcher pid                | macOS Helper             | fails launcher requirement                                                                       | accepted       | security negative case                               |
| ZPREVIEW-009 | different prod/Preview versions                  | use CUA sequentially              | Helper install           | separate version directories avoid replace/downgrade conflict                                    | accepted       | operational isolation only                           |
| ZPREVIEW-010 | both apps running                                | open `zcode://`                   | OS scheme handler        | current default handler receives callback                                                        | ignored        | accepted limitation                                  |
| ZPREVIEW-011 | both apps running                                | run two CUA sessions concurrently | global mouse/keyboard    | behavior not supported                                                                           | pruned         | user states this does not occur                      |
| ZPREVIEW-014 | eligible MR pipeline                             | inspect `approve-mr` stage        | CI UI                    | optional `build:preview` manual job is present beside MR approval                                | accepted       | explicit internal entry                              |
| ZPREVIEW-015 | `build:preview` clicked                          | create child pipeline             | CI workflow              | same MR ref/SHA; force `ZCODE_ENV=test`; distinct Preview output path                            | accepted       | no manual variables required                         |
| ZPREVIEW-016 | Preview child created                            | evaluate child jobs               | CI DAG                   | full desktop/CUA/remote build and notify; no test/Web deployment/release jobs                    | accepted       | package-only boundary                                |
| ZPREVIEW-017 | non-MR pipeline                                  | evaluate manual job rules         | CI UI                    | `build:preview` is absent                                                                        | pruned         | current request is MR-level command only             |
| ZPREVIEW-018 | MR parent has checkout-derived default paths     | click `build:preview`             | child pipeline variables | parent defaults are not inherited; child cache/temp paths resolve from the child runner checkout | accepted       | regression for `mkdir: /.tmp: Read-only file system` |
| ZPREVIEW-019 | Preview trigger stops inheriting parent defaults | build signed packages             | child workflow           | signing/notarization variables remain mapped from same-project protected variables               | accepted       | variable isolation must not weaken signing           |

## Pruning Decisions

| Decision ID  | Pruned combinations                         | Guard/invariant                            | Product reason                              | Representative coverage             |
| ------------ | ------------------------------------------- | ------------------------------------------ | ------------------------------------------- | ----------------------------------- |
| ZPREVIEW-P01 | 两个应用同时执行 CUA                        | 任一时刻只有一个应用使用 CUA               | 无需引入全局 CUA lease 和新 UI 状态         | 分别验证 prod/Preview 可启动 Helper |
| ZPREVIEW-P02 | Preview 独立账号/任务/配置                  | 业务数据明确共享                           | Preview 仅是内部测试入口                    | 验证路径解析未改写 `ZCODE_HOME`     |
| ZPREVIEW-P03 | Preview 独立 scheme                         | 用户接受 deep-link 抢占                    | 避免改 OAuth callback 配置                  | 保留 `zcode` protocol 配置断言      |
| ZPREVIEW-P04 | Preview 更新 channel                        | Preview 禁止更新                           | 内部包由重新下载安装替换                    | 断言 updater、菜单和强更均禁用      |
| ZPREVIEW-P05 | branch/tag/web pipeline 展示 Preview 命令   | 手动入口仅限 MR                            | 与 MR merge/approve 同级是本次明确边界      | CI rules 静态断言                   |
| ZPREVIEW-P06 | 转发 parent 的 cache/temp/default variables | trigger 只允许显式 Preview controls 跨边界 | job-only runner paths 必须由 child 自己计算 | CI config 静态断言 + 真实 child log |

## Questions For User

当前没有未决产品问题。若未来要求两个应用同时执行 CUA，需新开全局输入 owner/lease 设计，不属于本变更。

## Accepted Cases

| Case ID      | Setup                                | Action                          | Assertions                                                                                       | Evidence layers               | E2E status                         |
| ------------ | ------------------------------------ | ------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------- | ---------------------------------- |
| ZPREVIEW-001 | `ZCODE_ENV=test`                     | 解析 electron-builder identity  | Preview product/app/executable/package identity 正确                                             | config                        | verified                           |
| ZPREVIEW-002 | `ZCODE_ENV=production`               | 解析 electron-builder identity  | 所有生产 identity 不变                                                                           | config                        | verified                           |
| ZPREVIEW-003 | 模拟 packaged test runtime           | 解析 desktop runtime paths      | name=`ZCode Preview`，Electron userData 分离                                                     | runtime + filesystem path     | verified                           |
| ZPREVIEW-005 | packaged test runtime                | 初始化更新器并构建菜单          | 不请求 feed、不显示更新入口、不执行强更                                                          | runtime + menu + network mock | verified                           |
| ZPREVIEW-006 | Preview app id + official Team       | Helper 校验 launcher            | requirement 接受                                                                                 | native requirement unit       | verified                           |
| ZPREVIEW-007 | production app id + official Team    | Helper 校验 launcher            | requirement 接受                                                                                 | native requirement unit       | verified                           |
| ZPREVIEW-008 | 其他 app id                          | Helper 校验 launcher            | requirement 拒绝                                                                                 | native requirement unit       | verified                           |
| ZPREVIEW-009 | Preview Host env                     | 解析 Helper 路径                | 使用 `computer-use/preview`，production path 不变                                                | service + filesystem path     | verified                           |
| ZPREVIEW-012 | macOS Preview CI                     | 缺少签名/公证凭据               | 构建 fail-closed                                                                                 | CI script test                | verified                           |
| ZPREVIEW-013 | 三平台 Preview 产物                  | 安装并启动，与生产版并行        | 两个进程同时存在、基本功能可用                                                                   | manual signed artifact smoke  | missing                            |
| ZPREVIEW-014 | 目标为 `main`/`staging` 的 MR        | 创建父 pipeline                 | `approve-mr` 阶段存在 optional `build:preview` 手动 job                                          | CI config                     | verified                           |
| ZPREVIEW-015 | MR 父 pipeline                       | 点击 `build:preview`            | child 使用同 MR SHA，固定 `ZCODE_ENV=test` 和独立 Preview 目录                                   | CI config                     | verified                           |
| ZPREVIEW-016 | Preview child                        | 展开 include 和 job rules       | 复用全平台 build/签名/公证/通知；排除测试、Web 部署和 release                                    | CI config                     | verified                           |
| ZPREVIEW-018 | parent 默认变量引用 `CI_PROJECT_DIR` | 点击 `build:preview`            | trigger 设置 `inherit:variables:false`；child 不收到 parent 派生的 `/.tmp`、`/.npm-cache` 等路径 | CI config + runner log        | verified (config); runtime pending |
| ZPREVIEW-019 | 同项目 Preview child                 | 解析 workflow signing variables | Apple 签名/公证变量仍由 child workflow 从 protected variables 映射                               | CI config                     | verified                           |

## Verification Results

- `pnpm typecheck`: passed.
- `pnpm lint`: passed with 0 errors; 59 existing repository warnings remain outside this change.
- `pnpm exec vitest run packages/desktop/test/ciNodeVersionConfig.test.ts`: 1 file passed, 20 tests passed；覆盖 Preview 手动 job、parent 默认变量继承隔离、child workflow 变量、签名变量、include 边界和禁用的 Web 远控 job。
- YAML syntax parse: `.gitlab/ci/00-workflow.yml` 与 `.gitlab/ci/preview-child.yml` 均通过。
- Preview packaging 基线的 `pnpm test:unit:affected`: expanded to the full unit suite by the repository pre-push rule; 841 files passed, 6478 tests passed, 1 skipped.
- 本次手动触发改动的 `pnpm test:unit:affected`: passed；lint-staged 选中 CI 配置测试，1 file / 20 tests passed。
- electron-builder schema validation: both `ZCODE_ENV=test` and `ZCODE_ENV=production` configurations passed; resolved Preview identity is `dev.zcode.app.preview` / `ZCode Preview` / `zcode-preview` / `_TEST`.
- macOS scripts: `bash -n` passed; Preview missing-signing/notarization-credential paths are covered by fail-closed tests.
- Runtime failure evidence: GitLab Runner 18.7.2 中 parent default `ZCODE_CI_TMPDIR="$CI_PROJECT_DIR/.tmp"` 经 trigger 转发后变为 `/.tmp`，child 首个 setup 因 `mkdir: /.tmp: Read-only file system` 失败；根因修复为 `build:preview.inherit.variables=false`，不修改共享 build/sign/notarize DAG。
- Remaining manual gate: 在真实 MR 重试 `build:preview`，确认 child 的 temp/cache 路径位于 runner checkout 且完成全平台打包；安装签名的 macOS/Windows/Linux 产物并在目标系统验证 ZPREVIEW-013。

## Matrix Backfill

| File            | Change                                                                      |
| --------------- | --------------------------------------------------------------------------- |
| case catalog    | 本文作为 release/lifecycle 专用 case catalog，避免污染 conversation catalog |
| coverage matrix | 本文 `Accepted Cases` 记录 planned/missing 状态；实现后更新为 verified      |
| CUA specs       | 更新 launcher allowlist 与 Preview Helper 安装子目录                        |

## E2E Handoff Notes

- Provider fixture: 不需要；测试环境 endpoint 由既有 `ZCODE_ENV=test` 单测覆盖。
- File-system fixture: 临时 appData、`ZCODE_HOME/computer-use[/preview]`。
- Timing strategy: 配置/路径采用纯函数单测；双应用并行启动使用签名产物手工 smoke。
- Docker preset: 不适用。
- Review risks: macOS 签名 requirement 语法、Windows NSIS 并排安装、Linux deb package name、Preview 禁用强更。

## 追记 2026-09-13：生产后端的 ZCode Preview（`ZCODE_PREVIEW_IDENTITY`）

### 需求

内部希望拿到一个"连接生产后端、能用生产 BigModel / Z.ai 账号登录"的 `ZCode Preview`，且不新增第三种产品身份。
原设计里 `ZCODE_ENV` 同时决定后端环境和安装包身份，`test` 的 Preview 只能登录 `bigmodel.cn` / `zcode.z.ai`。

### 决策

| 项 | 决定 | 说明 |
| --- | --- | --- |
| 新增变量 | `ZCODE_PREVIEW_IDENTITY=1`（只认 `1`；`0`/空 = 关闭；其它拼写构建期直接失败） | 构建期开关；只控制**身份**，不碰后端环境。单一拼写与 CI 规则的 `== "1"` 精确比较同语义（2026-09-14 收紧，见下） |
| `ZCODE_ENV` 语义 | 不变，仍只表示后端环境 | 原 Boundary「新增第三种环境值」的排除继续有效 |
| 身份推导 | `flavor = ZCODE_PREVIEW_IDENTITY 为真 \|\| ZCODE_ENV=test ? preview : production` | 测试后端永远是 Preview，开关无法把测试后端包变成正式 `ZCode` |
| 身份含义 | 整套 Preview 身份，不是只改显示名 | appId `dev.zcode.app.preview`、`ZCode Preview` 应用名、独立 Electron `userData`、Linux `zcode-preview`、Helper 安装子目录 `computer-use/preview`、Windows AUMID |
| 更新 | Preview 身份在两种后端下都禁用 updater / 强更 / 菜单与标题栏更新入口 | stable feed 上只有正式 `ZCode` 安装包，装到 Preview bundle 上等于再装一份正式版 |
| 产物后缀 | `_TEST` 只标记 `ZCODE_ENV=test`；生产后端的 Preview 没有后缀 | 生产 Preview 靠 productName 区分：`ZCode Preview-<version>-mac-arm64.dmg` vs `ZCode-<version>-mac-arm64.dmg` |
| 发布链路 | `ZCODE_PREVIEW_IDENTITY == "1"` 与 `ZCODE_ENV == "test"` 同等对待：所有 release job `when: never`，`publish-release.sh` 硬拦截 | 生产后端的 Preview 仍是内部包 |
| CUA Helper | 不改 | app id 仍是 `dev.zcode.app.preview`，Helper 的 launcher allowlist 已接受 |

### 编译期常量

- `packages/shared/src/env.ts` 新增 `ZCodeProductFlavor = "production" | "preview"`、`ZCODE_PRODUCT_FLAVOR`、`normalizeZCodeProductFlavor(value, zcodeEnv)`。
- `tsup.config.ts` / `vite.config.ts` 注入 `__ZCODE_PRODUCT_FLAVOR__`；未注入 define 的 bundle（web、CLI、测试）回落为"跟随 `ZCODE_ENV`"的旧单轴语义。
- 打包后的应用**不能**依赖机器上的环境变量：身份和后端一样是编译期常量，主进程 / renderer 只读 `ZCODE_PRODUCT_FLAVOR`。

### 改为按身份判断的位置

| 位置 | 原判据 | 现判据 |
| --- | --- | --- |
| `packages/desktop/scripts/desktop-product-identity.mjs` | `ZCODE_ENV` | `resolveDesktopProductFlavor(env)`；`artifactSuffix` 移出身份记录，改为 `resolveDesktopArtifactSuffix(env)` |
| `desktopRuntimeEnv.ts` `isPreviewPackagedRuntime` | `ZCODE_ENV === "test"` | `ZCODE_PRODUCT_FLAVOR === "preview"` |
| `index.ts` AUMID / `initAutoUpdater.enabled` / force-update gate | `ZCODE_ENV` | `ZCODE_PRODUCT_FLAVOR`（`resolveWindowsAppUserModelIdForFlavor`） |
| `desktopApplicationMenu.ts` 检查更新菜单项 | `ZCODE_ENV === "production"` | `ZCODE_PRODUCT_FLAVOR === "production"`；endpoint 切换子菜单仍看 `ZCODE_ENV` |
| `packages/ui/.../WindowsCaptionMenuButton.tsx` `shouldShowDesktopUpdateEntry` | `ZCodeEnv` | `ZCodeProductFlavor` |
| `scripts/notarize-macos.sh` `is_preview_package` / `is_strict_release` | `ZCODE_ENV=test` | 加上 `ZCODE_PREVIEW_IDENTITY`；Preview 永不进入 strict release |
| `scripts/sign-macos-runtime-binaries.sh` fail-closed | `ZCODE_ENV=test` | `is_preview_package` |
| `scripts/doctor-macos-release-app.sh` 默认 Helper variant | `ZCODE_ENV=test` | 加上 `ZCODE_PREVIEW_IDENTITY` |
| `scripts/upload-oss.sh` / `scripts/package-cua-helper-release.mjs` `is_strict_release` | `ZCODE_ENV != test` | 再排除 Preview 身份 |
| `scripts/publish-release.sh` | 拒绝 `ZCODE_ENV=test` | 同时拒绝 `ZCODE_PREVIEW_IDENTITY` 为真 |
| `scripts/notify-feishu.mjs` | 标题只带环境 | `production` + 身份开关时追加 `· ZCode Preview`，其余标题不变 |

保持按后端环境判断、未改动的位置：`zcodeEndpoint.ts` 全部端点解析、OAuth provider 配置、source headers、`resolveZCodeEndpointSelection`、`30-build.yml` 的 test remote assets 分支、退出确认与 endpoint 菜单。

### CI 入口

| 入口 | 变量 | 产物目录 |
| --- | --- | --- |
| MR `approve-mr` 阶段新增手动 job `build:preview:production` | 转发 `ZCODE_PREVIEW_PIPELINE=1`、`ZCODE_PREVIEW_IDENTITY=1`、`ZCODE_ENV=production`、`TARGET_OUTPUT_DIR` | `@electron-preview/<source-branch>/`，复用 `preview-child.yml` |
| 手动 pipeline（web / api / trigger）传 `ZCODE_PREVIEW_IDENTITY=1` | `ZCODE_ENV` 留空或 `production` | `@electron-preview/<ref>/` |
| MR pipeline 带 `ZCODE_PREVIEW_IDENTITY=1`（API 创建） | 同上 | `@electron-preview/<source-branch>/` |

- `.ci:resolve-zcode-env`（bash + PowerShell）把开关收敛为 `1` / 未设置，其它拼写直接失败。
- child workflow 规则：身份规则条件写成 `$ZCODE_PREVIEW_IDENTITY == "1" && $ZCODE_PREVIEW_PIPELINE == "1" && $CI_PIPELINE_SOURCE == "parent_pipeline"`，排在测试 child 规则之前；原测试规则不变。
- tag / `ci/*` 流水线不识别该开关；即便被 API 注入，`50-release.yml` 的 7 个发布 job 也会 `when: never`。

### 新增用例

| Case ID | Setup | Assertion | Evidence | Status |
| --- | --- | --- | --- | --- |
| ZPREVIEW-020 | `ZCODE_ENV=production ZCODE_PREVIEW_IDENTITY=1` | electron-builder 解析为 Preview 身份、无 `_TEST` 后缀 | `desktopProductIdentity.test.ts`、真实加载 `electron-builder.config.js` 四组组合 | verified |
| ZPREVIEW-021 | `ZCODE_ENV=test ZCODE_PREVIEW_IDENTITY=0` | 仍是 Preview，开关不能生成测试后端的正式 `ZCode` | `desktopProductIdentity.test.ts` | verified |
| ZPREVIEW-022 | renderer / shared 注入 `__ZCODE_PRODUCT_FLAVOR__=preview` + `__ZCODE_ENV__=production` | `ZCODE_ENV=production`、`ZCODE_PRODUCT_FLAVOR=preview`；更新入口隐藏 | `shared/test/env.test.ts`、`viteRendererConfig.test.ts`、`windowsCaptionMenuButton.test.ts` | verified |
| ZPREVIEW-023 | 生产后端 Preview 缺少 Apple 凭据 | notarize fail-closed，寻找 `*mac-arm64.dmg`（无 `_TEST`） | `notarizeMacosScript.test.ts` | verified |
| ZPREVIEW-024 | `publish-release.sh` 收到 `ZCODE_PREVIEW_IDENTITY=1` | 退出 1，不读取密钥 | `publishReleaseScript.test.ts` | verified |
| ZPREVIEW-025 | CI 配置 | `build:preview:production` 存在且 optional；三条身份规则写 Preview 目录且带签名变量；7 个 release gate 含身份条件 | `ciNodeVersionConfig.test.ts` | verified |
| ZPREVIEW-026 | 生产后端 Preview 与正式 `ZCode` 并排安装，用生产 BigModel 账号登录，无更新检查 | 两进程共存、登录成功、日志无 `[auto-update]` 请求 | manual signed artifact smoke | missing |

### 验证

- `pnpm typecheck`：passed。
- `oxlint` 对改动文件：0 errors。改动文件中 6 个在 HEAD 已非 formatter-clean，只对新增行做了格式化。
- `vitest`：`packages/desktop/test`、`packages/shared/test`、`packages/ui/test` 全量 1296 文件，含 `desktopProductIdentity`、`ciNodeVersionConfig`、`notarizeMacosScript`、`publishReleaseScript`、`notifyFeishuScript`、`viteRendererConfig`、`tsupChunkIsolation`、`desktopRuntimeEnv`、`desktopApplicationMenu`、`shared/env`、`ui/windowsCaptionMenuButton`；唯一一次失败是 `desktopApplicationMenu.test.ts` 的手写 `@zcode/shared` mock 缺少新导出 `ZCODE_PRODUCT_FLAVOR`，补上 getter 后通过（`dev-cua-plugin-runtime.test.ts` 在新 worktree 需先构建 zcode-cli 包树，与本改动无关，构建后通过）。
- `scripts/ci/ci-lint-pipeline.mjs`：OK；改动的 YAML 可解析。
- 未执行：真实 CI 上点击 `build:preview:production`，以及 ZPREVIEW-026 的签名产物手工 smoke。

## 追记 2026-09-14：审查修正——漏改的更新入口与开关真值集合

MR !2636 合入后 bug scanner 报出两项，均成立，本轮修正：

### CR-01 托盘与命令入口仍按 `ZCODE_ENV` 放行更新检查

- 漏改位置：`desktopTray.ts` 的托盘「检查更新」菜单项、`desktopCommandHandlers.ts` 的 `DesktopCommandIds.CheckForUpdates` 分支。生产后端 Preview 下两者都会调用 `checkForUpdateMenuClick`，而 `initAutoUpdater({ enabled: false })` 只清轮询并 return，electron-updater 实例保持未配置（占位 feed `http://localhost:8081`、`autoDownload` 未设为 false），手动检查会对占位 feed 发真实请求。
- 修正：两处判据改为 `ZCODE_PRODUCT_FLAVOR === "production"`；并在 `autoUpdater.ts` 增加模块级 `autoUpdaterDisabledForProductFlavor`，`initAutoUpdater({ enabled: false })` 置位，`checkForUpdateMenuClick` 在打包态闸后再检查该位，命中即回 `dev-skipped` 并记录 `[auto-update] skip manual check: updater disabled for this product flavor`，不触碰 updater 实例。禁用语义从"每个入口各自判断"收口为"模块内 fail-closed"。
- 未改的 `ZCODE_ENV` 判据（均为后端语义，保留）：`setZCodeEndpointOverride`、endpoint 子菜单、`resolveZCodeEndpointSelection`、退出确认、remote assets、logger/telemetry 的 e2e 分支。

### CR-02 开关真值集合在 YAML 层与脚本层不一致

- 问题：workflow 三条身份路由规则与 `50-release.yml` 七个发布门做 `$ZCODE_PREVIEW_IDENTITY == "1"` 精确比较，而 `resolve_zcode_env`、identity resolver 与全部脚本接受 `1/true/yes/on`。`ZCODE_PREVIEW_IDENTITY=true` 会在路由层漏匹配（落入 `@electron/dev/…`、发布门不触发），却在脚本层被当成开启，打出 Preview 身份包进生产验收目录。
- 决策：**收紧为单一拼写 `1`**（`0`/空 = 关闭），不走 YAML 正则放宽。理由：一个值在 YAML、bash、PowerShell、Node 四处只需一种比较；GitLab 规则层保持精确比较最不易出错。
- 修正位置：`resolve_zcode_env`（bash + PowerShell）只接受 `1` / `0` / 空，其它值失败；`desktop-product-identity.mjs` 的 `isPreviewIdentityRequested` 对其它值直接 `throw`（tsup / vite / electron-builder 在构建期 fail-closed，本地 `ZCODE_PREVIEW_IDENTITY=true pnpm bundle:desktop` 不会静默打出正式包）；五个 shell 脚本、`publish-release.sh`、`package-cua-helper-release.mjs`、`notify-feishu.mjs` 同步只认 `1`；上方决策表真值列已更新。
- YAML 规则与发布门不变（`== "1"` 已是目标语义）。

### 新增用例

| Case ID | Setup | Assertion | Evidence | Status |
| --- | --- | --- | --- | --- |
| ZPREVIEW-027 | `initAutoUpdater({ enabled: false })` 后调用 `checkForUpdateMenuClick` | 不调用 `checkForUpdates` / `setFeedURL`，向 renderer 发 `dev-skipped`，记录禁用日志 | `autoUpdaterReadyState.test.ts` | verified |
| ZPREVIEW-028 | `ZCODE_PREVIEW_IDENTITY` 取 `true/yes/on/false/no/off/2` | identity resolver 抛 `expected 1 or 0` | `desktopProductIdentity.test.ts` | verified |
| ZPREVIEW-029 | CI 配置 | `resolve_zcode_env` 两个实现均不含 `true/yes/on` 真值列表 | `ciNodeVersionConfig.test.ts` | verified |
| ZPREVIEW-030 | 生产后端 Preview 打包态点击托盘「检查更新」 | 入口不存在 | 托盘模块无单测，待 ZPREVIEW-026 手工 smoke 一并覆盖 | missing |

### 验证

- `pnpm typecheck`：通过。`oxlint` 改动文件：0 errors；仅格式化新增行（含上一轮遗留的 `notify-feishu.mjs` 长调用行）。
- `vitest`：`autoUpdaterReadyState`、`desktopProductIdentity`、`ciNodeVersionConfig`、`desktopCommandHandlers`、`desktopApplicationMenu`、`desktopMainIpcPlatform`、`notifyFeishuScript`、`publishReleaseScript`、`notarizeMacosScript`、`runtime-asset-scripts`、`uploadOssScript`、`macosReleaseAppDoctor`、`viteRendererConfig`、`tsupChunkIsolation`、`electronBuilderLinuxPackageTargets` 15 文件 263 用例通过。
