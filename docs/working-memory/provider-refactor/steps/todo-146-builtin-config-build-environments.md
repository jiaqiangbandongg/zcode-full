# Todo146：按产品环境打包 Built-in Provider 配置

状态：已实现、已完成本轮构建验证与复审。

> 后续裁决：Todo147 改为以生产文件为唯一编辑源，脚本派生测试账号 URL 与站点规则。
> 下方“两份初始一致”仅记录本 Todo 完成时的状态，不再要求后续独立维护。

## 已裁决范围

- 正式配置保留 `config/provider/zcode-builtin.json`，新增 `zcode-builtin.test.json`。
  初始内容与 revision 完全一致，后续允许独立维护。
- 由构建期 `ZCODE_ENV` 选择，不由分支或 `NODE_ENV=production` 推断产品环境。
- Desktop、CLI、SEA、HTTP Server、远程 Server、Server CLI 共用构建选择与校验入口。
- 输出资源路径和运行时 Schema 不变，不新增 Overlay，不迁移个人配置，不发布在线配置。
- 复用旧 CLI JS 时也必须更新配置；Turbo 缓存记录环境与配置输入。
  远程 tar 继续复用已有内容哈希，不重复建设缓存。

详细契约：[双环境打包](../../../builtin-provider-config-build-environments.md)。

## 验收

- [x] 不同环境、相同环境内容变化均能进入最终配置资源／嵌入产物。
- [x] 缺失、JSON 损坏、Schema 错误直接构建失败，不偷偷使用另一份配置。
- [x] 复用 JS、SEA 资源、Desktop 与 Server 入口覆盖；开发态和打包态路径正确。
- [x] 两份真实配置初始完全一致、均通过完整解码。
- [x] 类型、Lint、受影响测试、构建与整体复审完成；记录未覆盖的实机打包限制。

## 2026-09-14 验证与复审

- 新增构建契约 13 项通过：不同内容的临时 Release、环境选择、缺失与损坏、
  同环境更新、复用 JS 后刷新、真实 CLI 构建、SEA 资源，以及 tsup 配置自身打包后的执行。
  Node 契约通过 Vitest 包装用例纳入日常回归。
- 相关 11 个 Vitest 文件共 103 项通过（含上述 Node 契约入口）；类型、格式、架构检查通过，
  Lint 0 错误、42 条既有警告。
- CLI build / SEA 原有测试 50 项通过、1 项既有失败：SEA/TUI 提取闭包缺
  `@zcode/shared/src/index.ts`。已在干净 `hotfix/3.12.2` 基线复现相同错误，不扩大本次修复。
- 实际构建通过：CLI desktop-agent、Desktop main/host/preload/scheduler、HTTP Server、远程 Server、Server CLI。
  CLI 最终旁置 JSON 与选中源文件逐字节一致。
  已解析三个 Server 最终 JS，确认嵌入字符串与选中 JSON 完全一致。
- Turbo dry-run 确认两份配置和公共工具进入 inputs，test/production 产生不同 hash。
  缓存声明只扩大 CLI 两个打包任务，不让普通依赖包因 JSON 改动全部重编译。
- 实跑发现 tsup 会内联配置依赖并重定位 `import.meta.dirname`：已改为动态加载公共构建工具，
  并补真实配置加载器回归，不依赖只读路径推断。
- 两份配置均为 revision 26，字节 SHA-256 均为
  `9aae91bac60f689edf8265806aba2317f1eac12b5793f32be14bdac462651e2d`。
- 复审确认：不改变运行时环境注入、在线更新优先级、用户数据及连续／可重放消息链。
  未执行 macOS/Windows 完整签名安装包、完整 SEA 可执行文件及实机安装验收；
  无 UI 交互变更，未新增桌面交互 E2E。未推送、未发布远端配置。
