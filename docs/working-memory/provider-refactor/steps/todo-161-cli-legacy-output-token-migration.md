# Todo161：CLI 旧 config.json 首次迁移保留输出上限

状态：2026-10-14 基于最新 staging 重新移植，生产修复、61 项定向回归及必要静态检查已通过；当前验证记录见末节。9 月结果保留为历史证据。

## 背景与调查结论

评测团队仍使用 CLI 配置目录下的旧 `config.json` 定义 Provider 和模型输出上限，需要在首次导入新 Provider 配置时保留该值。

- 默认来源为 `~/.zcode/cli/config.json`，由 `getDefaultConfigPath()` 定位；Standalone 的既有 `legacyCliUserConfigFilePath` 注入入口保持可用。
- [旧格式 parser](../../../../apps/zcode-cli/packages/bootstrap/src/app/legacy-cli-model-config.ts)已经接受模型的 `maxOutputTokens`、`limit.output` 和 `options`。
- [CLI 导入器](../../../../apps/zcode-cli/packages/bootstrap/src/app/legacy-cli-personal-provider-config-importer.ts)的成员投影只保留 `contextWindow`，创建模型规则时还会跳过没有 context 的成员，导致输出上限丢失。
- [旧配置测试](../../../../apps/zcode-cli/packages/adapters/tests/config.test.ts)记录的优先级为 `limit.output` → `options.max_tokens` → 模型顶层 `maxOutputTokens`。
- [当前导入测试](../../../../apps/zcode-cli/packages/bootstrap/tests/legacy-cli-personal-provider-config-importer.test.ts)仍有“不迁移历史 model options 中的输出上限”的断言，需要按本项裁决调整。

2026-09-16 调查时运行 CLI 导入测试，13 项中 5 项通过、8 项失败，主要涉及测试仍按旧序列化结构断言；这是修改前的证据，不是本项修复结果。当前机器没有上述默认旧配置文件，尚未核对评测团队真实样本，不保存 Key 或完整用户配置。

## 已确认范围与字段契约

1. 仅修改 **Standalone CLI 旧配置首次导入**，输入为旧用户文件的 `provider.<providerId>.models.<modelId>`。沿用既有 Provider 身份、来源、删除项与重复成员过滤规则。
2. 输出上限按 `limit.output` → `options.max_tokens` → `maxOutputTokens` 取有效正整数，写入对应新模型规则的 `config.optionSpecs.maxOutputTokens.max`。不物化整个 Built-in 模型配置，不复制 API 参数映射或任意 options；map 继续由现有配置合成链提供。
3. 仅有输出上限而没有 `contextWindow` 的模型也必须生成规则；两者都有时同时保留。两者都缺失时维持现有行为，输出字段缺失时不写入默认值。
4. 非法值不进入新配置，保持现有 parser 的输入校验边界；明确测试合法候选的优先级与非法 options 值的处理，不用隐式数值转换接受字符串或小数。
5. **已迁移用户不处理**。正式 Personal 配置已存在时沿用直接读取行为，不补迁、不覆写、不增加迁移版本或标记，也不持续读取旧文件。评测在旧文件中修改输出上限后再次启动是否生效，仍受这一首次导入边界约束。
6. 不修改 Desktop 的 `legacyPersonalProviderConfigImporter`，不导入桌面旧 Store、项目配置或环境变量中的输出值。保留原始 CLI 旧文件，不双写。
7. 不扩展 `options.extra_body.max_tokens`、`max_completion_tokens` 等额外兼容字段，不改变推理档位、账号、默认选择或其他迁移语义；本项只落实本次确认的三种输出上限字段。

迁移与执行顺序沿用 [Todo33](todo-33-personal-provider-config-file-cutover.md) 的唯一持久化 owner：

```text
Standalone Provider Runtime
  → Personal Repository 检查正式文件
      ├─ 已存在：读取正式配置，结束旧文件导入
      └─ 不存在：锁内重查 → CLI Legacy Importer 读取旧 config.json
                 → 提取 context / output 稀疏规则
                 → 原子保存 Personal 配置 → Registry 合成 → 正常模型请求
```

本项取代 CLI 导入测试中“输出上限不迁移”的预期；不扩大 Desktop 或已迁移用户的兼容范围。

## 实施与验收

- [x] 实施前把适用的现行迁移规格同步到上述最终契约；历史记录保留，避免将旧阶段说明当作当前行为。
- [x] 先补回归：三种字段分别迁移、同时存在时的优先级、只有 output、context 与 output 并存、output 缺省与非法值、删除和重复模型过滤；证明旧实现会丢值，再修改 CLI 导入器。
- [x] 修正该导入测试文件过时的序列化断言，优先断言当前正式规则与字段；不将顺带修正断言扩展为其他产品语义变更。
- [x] 使用临时 CLI 配置目录及离线 Provider fixture，覆盖旧文件读取 → 首次导入 → 正式文件保存与重读 → Registry 合成；断言显式输出值保留、API map 仍继承、旧文件内容不变。
- [x] 正式配置存在时，改变旧文件输出值并重启，确认不重新导入；本项不承诺持续读取评测旧配置。
- [x] 通过本地 scripted Provider 捕获实际 CLI 模型请求，证明迁移值进入对应 API 输出预算字段；不以 JSON 保存成功代替请求生效验证，不使用真实 Key 或付费模型。
- [x] 按根与 CLI 规则运行受影响测试、typecheck、lint、架构检查并自审；明确区分既有失败、本次结果与未验证项。测试命令可从 `pnpm --dir apps/zcode-cli --filter @zcode/bootstrap exec vitest run tests/legacy-cli-personal-provider-config-importer.test.ts` 开始，不能用根单测代替 CLI 验证。

## 2026-09-17 实施与验证记录

生产改动仅在 CLI Legacy Importer：按已确认优先级取有限正整数，为仅输出值或 context/output 并存的模型生成稀疏规则；未改 parser、Desktop 导入器、Repository 生命周期或持久化 Schema。已同步现行 configuration 规格与 Todo35 后续裁决，并将旧导入测试改为当前规则结构断言。

- 先在未修改实现时运行回归，34 项中 17 项失败，失败均指向合法输出规则缺失；修改后导入、字段边界、默认选择集成和本地请求集成共 40 项通过。另运行进程 Registry 与模型工厂调用方测试，19 项通过，合计 59 项。
- 新增 runtime 测试通过临时 CLI `config.json`、真实 Standalone 组合根、Personal 文件和 Registry 启动普通 Agent Turn，向本地 HTTP fixture 发送真实 SDK 请求。三种 API 的 `max_tokens`、`max_completion_tokens`、`max_output_tokens` 均捕获到 `24000`；未从测试调用方手动指定请求预算。fixture 故意返回 400 终止本轮，验证目标是出站参数，不代表上游模型生成成功。
- 重启测试读取已落盘正式文件；即使旧文件改为 `8000`，Registry 仍为 `24000`，正式文件字节不变。首次导入也确认旧文件字节不变，未访问真实 Key 或付费模型。
- `pnpm typecheck`、`pnpm lint`（54 warnings / 0 errors）、`pnpm --dir apps/zcode-cli typecheck`（28 tasks）及 `pnpm architecture:check --changed`（0 violations）通过。架构策略中的 CLI 为 legacy 模块，门禁通过不等同于完整运行时证明。
- 本次 4 个 TypeScript 文件的局部 lint、格式检查，以及 diff 和文档链接检查通过。
- `pnpm --dir apps/zcode-cli lint` 失败：例如未修改的 `contracts/src/workflow/index.ts`、`interfaces/session-store.port.ts`、`interfaces/browser-control.port.ts`、`events/event-reducer.ts`、`model/index.ts` 共 5 个 `max-lines` 错误；Bootstrap 还有 `plugins.ts` 等既有超限文件。上述示例已与 HEAD 比对、无改动。未通过改规则或扩大重构绕过失败。

未验证真实评测团队配置、外部模型成功响应、Windows/macOS 实机；本项未改变桌面或手机交互。CLI 全量 lint 尚未收口，不宣称必要验证全部通过；用户知悉既有行数错误后明确要求直接 commit，本次按授权提交并保留失败记录。工作区同时存在其他任务改动，本项未修改或收录它们。

## 2026-10-14 基于 staging 重新移植

旧修复提交 `bb7f88002c` 留在旧特性分支，未进入 staging。本次从 `5e74234f49` 建立独立修复分支，只移植本项修复、测试与规格，不合入旧分支的其他功能。

- 生产转换逻辑沿用原修复；当前 staging 的测试已修正序列化结构，保留这些断言，仅增加输出预算预期。
- 实际运行发现 `createSqliteSessionStore()` 已变为异步工厂；请求集成夹具改为等待初始化，生产存储和请求链路不变。
- 修改生产实现前，34 项导入回归中 17 项因输出上限丢失失败；修复后相关 6 个测试文件共 61 项通过，包括原有调用方新增的回归。
- 三种 API 的真实 SDK 请求均由本地 HTTP fixture 捕获到 `24000`；正式文件重读、旧文件不变、重启不重新导入仍通过。fixture 返回 400 是主动终止请求的测试设计，不代表外部模型成功响应。
- 根 affected 预览与正式执行均选中 0/2633；CLI 不属于根测试套件，由上述 CLI 定向回归覆盖。未运行全量单测。
- 根 `pnpm typecheck`、CLI `typecheck`（30 tasks）通过；根 lint 为 0 errors / 210 warnings，CLI lint 为 0 errors / 68 warnings，另按现有策略接纳 14 项原样上游行数诊断。本次不再有 9 月的行数阻塞。
- `pnpm architecture:check --changed` 为 0 violations；4 个 TypeScript 文件通过 CLI 自有 formatter 检查，diff、文档引用及开源词汇检查通过。只验证当前任务范围，不扩大为全量测试。
- 真实评测配置、外部模型成功响应和 Windows/macOS 实机未验证。产品范围仍限 CLI 首次迁移；本地分支准备完成不代表已合入远端 staging。
