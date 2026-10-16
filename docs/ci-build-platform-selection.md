# CI 打包平台选择

## 目标

允许创建 GitLab pipeline 时通过可选变量 `ZCODE_BUILD_PLATFORMS` 指定自动打包的平台。MR pipeline 默认只自动打包 macOS ARM64 和 Windows x64，手动创建的 pipeline 未传变量时仍保持全平台自动打包。

## 平台标识

变量使用逗号分隔的完整平台标识，支持以下值：

- `macos-arm64`
- `macos-x64`
- `windows-x64`
- `windows-arm64`
- `linux-x64`
- `linux-arm64`

示例：

```text
ZCODE_BUILD_PLATFORMS=macos-arm64,windows-x64
```

在 GitLab **Run pipeline** 页面手动创建流水线时，可以在 Variables 中填写该变量；通过 Pipeline API 或 Trigger API 创建 pipeline 时同样可以传入。这些手动触发方式都使用相同的平台选择规则。

## 行为契约

- MR pipeline 由 workflow 默认注入 `ZCODE_BUILD_PLATFORMS=macos-arm64,windows-x64`，因此只自动运行 macOS ARM64 和 Windows x64；其余平台保留为非阻塞 manual job。
- GitLab **Run pipeline**、Pipeline API 和 Trigger API 手动创建的 pipeline 未传或传入空的 `ZCODE_BUILD_PLATFORMS` 时，六个平台 job 全部按现有方式自动运行。
- 传入非空列表时，列表内的平台 job 自动运行。
- 传入非空列表时，列表外的平台 job 保留在 pipeline 中，状态为可选手动执行，且未执行时不阻塞流水线。
- 平台判断使用逗号边界的完整 token 匹配，禁止用平台名或架构子串进行模糊匹配。
- 变量在 GitLab 创建 pipeline 时参与 job graph 求值；GitLab UI 的 **Run pipeline** 属于受支持的手动 pipeline 创建入口。
- pipeline 创建后点击某个 manual job，或给该 job 临时填写变量，不会改变其他 job 已经确定的调度状态。
- 该选择规则用于 MR、GitLab **Run pipeline**（`web`）、Pipeline API（`api`）和 Trigger API（`trigger`）创建的 pipeline。
- tag 与 `ci/*` 发布验证 pipeline 始终保持六个平台自动打包，避免正式上传/发布 DAG 缺少平台产物。

## 调度时序

```text
创建 pipeline
  |
  +-- MR pipeline
  |     `-- workflow 注入 macos-arm64,windows-x64
  |           +-- macOS ARM64 / Windows x64 -> on_success
  |           `-- 其他平台                  -> manual + allow_failure
  |
  `-- Web / Pipeline API / Trigger API
        |
        +-- ZCODE_BUILD_PLATFORMS 未传或为空 -> 所有平台 job on_success
        `-- ZCODE_BUILD_PLATFORMS 为非空列表
              +-- 当前平台完整命中 -> on_success
              `-- 当前平台未命中   -> manual + allow_failure
```

## 实现边界

- 选择逻辑只控制六个桌面安装包 build job，不通过脚本提前退出，避免未选择的平台占用 runner。
- 平台 build template、打包命令、产物目录、上传和发布逻辑保持不变。
- 与 macOS 安装包绑定的 CUA Helper job 跟随对应 macOS 平台选择，避免仅选择一个 macOS 架构时仍自动构建另一架构 helper；未选择的 helper 同样保留手动入口。
- 飞书构建通知跟随对应平台是否自动打包；未选择的平台不自动通知，后续手动执行该平台 build 时仍可按需手动执行其通知 job。
- 平台无关的 `build:desktop:app` 和 remote assets job 不属于平台列表，保持现有调度行为。

## 验证

自动化测试覆盖：

- 六个平台 build job 都声明相同的可选参数调度契约。
- 两个 CUA Helper job 与对应 macOS 平台使用一致的调度契约。
- MR workflow 默认注入 `macos-arm64,windows-x64`。
- 变量缺失或为空时，规则回落到自动运行。
- 变量非空且未命中时，job 为非阻塞手动执行。
- 平台匹配包含明确的逗号 token 边界。
