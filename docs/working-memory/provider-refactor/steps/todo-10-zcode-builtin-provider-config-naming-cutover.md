# 10 ZCode Built-in Provider Config 命名切换

> 状态：已完成
>
> 日期：2026-08-24
>
> 来源审查：[`../provider-implementation-architecture-conformance-review.md`](../provider-implementation-architecture-conformance-review.md)
>
> 总路线图：[`todo-00-model-abstraction-unification-roadmap.md`](./todo-00-model-abstraction-unification-roadmap.md)

## 1. 任务目标

把 Provider Refactor 中仍使用 `official` 表达 ZCode 内置配置的领域、实现和物理命名，一次性切换为
`zcodeBuiltin` / `zcode-builtin`。切换完成后，ZCode 自带的 Provider/Model 配置只有一个准确名称：
**ZCode Built-in Provider/Model Config**。

当前分支的 Provider Refactor 尚未上线，不存在需要继续读取的已发布 Provider Config 协议、环境变量或物理文件。
因此本 Todo 是原子重命名，不是兼容迁移：不保留 alias、deprecated export、双字段、双读写、旧环境变量
fallback、旧路径 fallback 或 importer。

```text
当前命名链

config/provider/official.json
        |
        v
OfficialProviderConfigSource
        |
        v
officialProviders / officialModels
        |
        v
ProviderConfigService / Resolver / Facade
        |
        +--> Desktop Host init: officialProviderConfigFilePath
        `--> CLI env / SEA: ZCODE_OFFICIAL_PROVIDER_CONFIG_FILE

目标命名链

config/provider/zcode-builtin.json
        |
        v
ZCodeBuiltinProviderConfigSource
        |
        v
zcodeBuiltinProviders / zcodeBuiltinModelRules
        |
        v
ProviderConfigService / Resolver / Facade
        |
        +--> Desktop Host init: zcodeBuiltinProviderConfigFilePath
        `--> CLI env / SEA: ZCODE_BUILTIN_PROVIDER_CONFIG_FILE
```

本 Todo 只改变名称，不改变 Overlay 顺序、模型成员、Access、Registry 完整性、设置页行为或模型调用行为。

## 2. 已确认裁决

### 2.1 领域术语

```text
ZCode Built-in Provider Config
        |
        v
overlay Account Built-in Provider Config
        |
        v
Effective Built-in Provider Config
        |
        v
overlay Personal Provider Config
        |
        v
Effective Provider Config

ZCode Built-in Model Config Rules
        +
Personal Model Config Rules
        |
        v
Effective Model Config Rules
```

`official` 不再是这条配置链的领域同义词。文档、公共类型、内部 API、局部变量、测试描述和错误信息都使用
上述 Built-in 术语。

### 2.2 代码和物理名称

| 当前名称                                   | 目标名称                                        |
| ------------------------------------------ | ----------------------------------------------- |
| `officialProviders`                        | `zcodeBuiltinProviders`                         |
| `officialModels`                           | `zcodeBuiltinModelRules`                        |
| `officialSource`                           | `zcodeBuiltinSource`                            |
| `OfficialProviderConfigSource`             | `ZCodeBuiltinProviderConfigSource`              |
| `createOfficialProviderConfigSource`       | `createZCodeBuiltinProviderConfigSource`        |
| `materializeOfficialProviderConfig`        | `materializeZCodeBuiltinProviderConfig`         |
| `resolveOfficialProviderConfigFilePath`    | `resolveZCodeBuiltinProviderConfigFilePath`     |
| `officialProviderConfigFilePath`           | `zcodeBuiltinProviderConfigFilePath`            |
| `isOfficial`                               | `isZCodeBuiltin`                                |
| `official-provider-config-source.ts`       | `zcode-builtin-provider-config-source.ts`       |
| `official-provider-config-materializer.ts` | `zcode-builtin-provider-config-materializer.ts` |
| `config/provider/official.json`            | `config/provider/zcode-builtin.json`            |
| `ZCODE_OFFICIAL_PROVIDER_CONFIG_FILE`      | `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE`            |
| SEA `zcode-provider/official.json`         | SEA `zcode-provider/zcode-builtin.json`         |
| 生成文件 `official-<hash>.json`            | 生成文件 `zcode-builtin-<hash>.json`            |

实现时若发现同一事实链上的其他 `official*` 符号，按同一规则直接重命名。`zcodeBuiltin` 用于明确表达
ZCode 产品下发的 Built-in 层；不能简化成会与 Account Built-in 混淆的无来源 `builtin`。

### 2.3 零兼容

以下做法全部禁止：

- 导出旧类名或旧字段名作为 alias；
- 同时接受 `officialProviderConfigFilePath` 与 `zcodeBuiltinProviderConfigFilePath`；
- 同时读取新旧环境变量；
- 新路径不存在时回退到 `official.json`；
- SEA 同时打包新旧 asset key；
- 为旧命名新增 migration/importer；
- 测试继续使用旧 helper，然后在生产边界转换。

旧名字出现就说明切换未完成，不是需要保护的兼容场景。

### 2.4 范围排除

`Official MCP`、Official Plugin/Marketplace、Official CUA、官网或产品文案中的 `official` 具有独立、正确的
业务含义，不属于 Provider Config 命名链，不得机械替换。

## 3. 当前事实与影响范围

2026-08-24 的定向扫描在生产代码中命中 40 个文件，另有发布配置文件和设计/计划文档：

| 区域                            | 命中文件数 | 主要职责                                      |
| ------------------------------- | ---------: | --------------------------------------------- |
| `packages/provider`             |         11 | Snapshot、Resolver、Service、Facade 和测试    |
| `packages/provider-node`        |          5 | 文件 Source、watcher、materializer 和 runtime |
| `packages/services`             |          7 | Service composition、Desktop/Host 注入        |
| `packages/shared`               |          2 | Host init 严格协议字段                        |
| `packages/desktop`              |          9 | Main/Host 消息、开发和打包路径                |
| `apps/zcode-cli`                |          6 | 环境变量、SEA asset、runtime 解包和构建脚本   |
| `config/provider/official.json` |          1 | 当前物理发布文件                              |

定向扫描命令：

```bash
rg -n \
  'officialProviders|officialModels|officialSource|OfficialProviderConfig|officialProviderConfigFilePath|ZCODE_OFFICIAL_PROVIDER_CONFIG_FILE|config/provider/official\.json|zcode-provider/official\.json' \
  packages/provider packages/provider-node packages/services packages/shared packages/desktop apps/zcode-cli config
```

本轮环境没有可调用的 codegraph 查询工具；影响面以 Feature Graph 的 `capability.provider-registry`、上述精确
扫描、`dep:refs`、TypeScript 和构建测试交叉验证，不能只依赖文本替换。

## 4. Impact Brief

### 4.1 功能与变更层级

| 字段             | 结论                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------- |
| Developer intent | 删除错误的 Provider Config `official` 术语，建立唯一 Built-in 命名                          |
| Capability       | Provider Registry / Config Source / Desktop 与 CLI 启动装配                                 |
| Change layer     | `persistence contract`、`commit-effect`、`validation`、build/package asset                  |
| Operating mode   | 一次原子切换                                                                                |
| Primary seeds    | `ProviderConfigSnapshot`、`OfficialProviderConfigSource`、Host init schema、CLI runtime env |
| Out of scope     | Provider 行为、Access、模型选择、设置交互、Queue/Recovery、其他 Official 产品概念           |

### 4.2 State owners 与跨进程链路

```text
Repository 发布文件
config/provider/zcode-builtin.json
        |
        +--> Desktop dev/package resolver
        |          |
        |          v
        |    Main -> Host init schema -> Services -> Provider Source
        |
        `--> CLI build / SEA asset
                   |
                   v
            runtime env/path resolver
                   |
                   v
             Provider Source

Personal Repository、Account Source、Registry Overlay 和 Active Model 不改变。
```

| 状态/事实                     | 权威 owner                           | 本 Todo 结果                        |
| ----------------------------- | ------------------------------------ | ----------------------------------- |
| ZCode Built-in 发布内容       | `config/provider/zcode-builtin.json` | 内容不变，只改物理名称              |
| Node Source snapshot/revision | `ZCodeBuiltinProviderConfigSource`   | watch/reload 行为不变               |
| Desktop Host 启动参数         | Shared strict schema                 | 原子改为新字段，不双读              |
| CLI 显式路径                  | `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` | 只认新变量                          |
| SEA 内置资产                  | `zcode-provider/zcode-builtin.json`  | 只打包/读取新 key                   |
| Provider Config Snapshot      | Provider Domain                      | 字段改名，解析结果不变              |
| Settings Built-in 标记        | Settings Facade View                 | 改为 `isZCodeBuiltin`，显示行为不变 |

### 4.3 UI Surface Matrix

| 用户场景          | 入口                 | 本 Todo 可见变化     | 必须保持的不变量                                 |
| ----------------- | -------------------- | -------------------- | ------------------------------------------------ |
| Provider 设置     | Provider Settings    | 无；内部只读标记改名 | Built-in 展示、Personal 编辑能力不变             |
| 普通模型选择      | Model selector       | 无                   | 候选顺序、enabled/visibility、选择状态不变       |
| Off-Peak/内部模型 | scoped Registry View | 无                   | hidden Provider 和精确创建语义不变               |
| Desktop/Web/手机  | 各客户端             | 无                   | continuous/replayable、远程 workspace 和队列不变 |

本 Todo 不需要新增 UI E2E；Provider Facade/Protocol 单测与 Desktop/CLI 启动、构建测试足以覆盖命名链。现有
代表性 UI 回归只用于证明行为未变。

## 5. 实施顺序

### A. 先写失败测试和机械门禁

1. 把 Source、materializer、Snapshot、Resolver、Facade、Host init、CLI runtime env 和 SEA asset 测试改为目标名称；
2. 增加“旧环境变量/旧路径不会被读取”的否定测试；
3. 建立本 Todo 第 7 节的精确 `rg` 归零命令。

测试与生产代码会在同一提交中原子切换，因此允许测试在重命名中的中间提交点暂时无法编译，但最终提交必须
恢复完整绿灯；不通过 alias 维持中间态。

### B. Provider Domain 与 Node Source

1. 重命名 `ProviderConfigSnapshot`、Resolver input、Service dependency/field/event reason 和 Facade input；
2. 将 Model 规则字段明确命名为 `zcodeBuiltinModelRules`，避免 `Models` 同时表达成员与 Rule；
3. 重命名 Node Source、watcher、materializer、runtime dependency、文件名和所有 exports/imports；
4. 错误信息和测试标题统一使用 `ZCode Built-in Provider Config`。

### C. Services、Shared Protocol 与 Desktop

1. 将 Services 组合参数和 Local Host 初始化字段改为 `zcodeBuiltinProviderConfigFilePath`；
2. 直接修改 `packages/shared` 的严格运行时 schema，不接受旧字段；
3. 同步 Desktop main/host 消息、开发路径、bundle/package 路径和测试 fixture；
4. 验证本地 Desktop 与同窗口 Host 的启动链不变；不修改 remote workspace、mobile attachment 或业务协议。

### D. CLI、SEA、构建和物理文件

1. 将显式环境变量改为 `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE`；
2. 将 SEA asset key 改为 `zcode-provider/zcode-builtin.json`；
3. 将运行时解包和 content-addressed materializer 文件名改为 `zcode-builtin-<hash>.json`；
4. 原子重命名 `config/provider/official.json` 为 `config/provider/zcode-builtin.json`；
5. 更新 build/package scripts、manifest、测试和文档引用；旧文件和旧 asset 不保留副本。

### E. Settings 投影与文档归零

1. 将 Provider Settings View 的 `isOfficial` 改为 `isZCodeBuiltin`；
2. 更新 Renderer/Protocol 消费者和测试，不改变可见性与编辑规则；
3. 将现行 Design、Feature Graph、实施 Todo 和当前开发文档中的 Provider Config 术语改为 Built-in；
4. 历史 implementation log 若必须保留原始证据，可在明确的历史引文中出现旧名；它不能继续作为当前 API 或
   目标设计用语。

## 6. 稳定验收用例

| Case ID | Setup                               | Action                             | Assertions                                                 |
| ------- | ----------------------------------- | ---------------------------------- | ---------------------------------------------------------- |
| ZBN-01  | 新发布文件存在                      | Node Source 启动并监听更新         | 正确解析、revision/watch 行为不变                          |
| ZBN-02  | 同一 Built-in 内容                  | materialize 两次                   | 使用稳定 `zcode-builtin-<hash>.json`，内容与原子写语义不变 |
| ZBN-03  | Desktop dev/package                 | 创建 Local Host                    | 只通过新 Host init 字段找到配置并构建 Registry             |
| ZBN-04  | CLI 显式新环境变量                  | 启动 Runtime                       | 读取新路径并生成相同 Provider/Model View                   |
| ZBN-05  | SEA binary                          | 无显式文件路径启动                 | 只从新 asset key 解包并装配 Built-in Config                |
| ZBN-06  | 只设置旧环境变量或只提供旧路径      | 启动 Runtime                       | 不读取旧入口，按缺失配置的正式错误失败                     |
| ZBN-07  | Provider Settings View              | 读取 Built-in 和 Personal Provider | `isZCodeBuiltin` 正确，UI 行为与保存结果不变               |
| ZBN-08  | 同一 Built-in/Account/Personal 输入 | 切换前后解析快照                   | Overlay 顺序、Effective Config 和 Registry 候选等价        |

## 7. 完成门禁

### 7.1 机械归零

Provider Config 正式链路中以下名称必须为零：

```text
officialProviders
officialModels
officialSource
OfficialProviderConfigSource
createOfficialProviderConfigSource
materializeOfficialProviderConfig
resolveOfficialProviderConfigFilePath
officialProviderConfigFilePath
ZCODE_OFFICIAL_PROVIDER_CONFIG_FILE
config/provider/official.json
zcode-provider/official.json
isOfficial（仅 Provider Settings Built-in 标记语义）
```

验收时用限定目录和语义过滤，避免误报 Official MCP、Plugin、CUA 或普通产品文案。另执行 `dep:refs` 检查旧
exports 没有通过 barrel 残留。

### 7.2 自动验证

- Provider/Provider Node/Services/Shared/Desktop/CLI 受影响单测；
- Desktop dev 与 package 路径解析测试；
- CLI 普通文件、显式 env 和 SEA asset 测试；
- `pnpm typecheck`；
- `pnpm lint`；
- `pnpm fmt:check`；
- 受影响构建与 `pnpm test:unit:affected`。

### 7.3 交付条件

1. 新旧名称不存在并行入口；
2. 旧物理文件、旧环境变量和旧 SEA asset 完全退出；
3. Provider Config 解析输出和产品行为不变；
4. Design、Feature Graph、步骤索引和审查结论全部指向本 Todo；
5. 以 Conventional Commit 提交实现、测试和文档。

## 8. 非目标

- 不重构 Config 内容、Overlay、Registry 或 ModelFactory；
- 不改变 Account/Personal Config、Access 或请求鉴权；
- 不改变 Provider/Model enabled、visibility、成员与冲突语义；
- 不修改模型选择、Off-Peak、Automation、Subagent、Repo Wiki 或任务状态；
- 不改变 Desktop continuous、Mobile replayable、远程 workspace、Queue 或恢复逻辑；
- 不清理与 Provider Config 无关的 `official` 业务概念；
- 不为从未发布的旧命名设计迁移和兼容。

## 9. 实现结果

- Domain、Node Source、Services、Shared Host init、Desktop、Server、CLI 与 SEA 已统一使用
  `zcodeBuiltin` / `zcode-builtin`；
- 物理发布文件、运行时物化文件、环境变量和 SEA asset 已一次性切换到最终名称；
- Provider Settings 的来源标记已改为 `isZCodeBuiltin`，没有保留旧字段；
- 旧环境变量仅存在于否定测试，生产代码不读取旧变量、旧路径或旧 asset；
- Provider、Provider Node、Desktop、Server、CLI 定向测试和全仓 TypeScript 检查通过。
