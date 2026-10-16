# Built-in Provider 配置双环境打包

## 所有权与边界

构建工具单独拥有配置选择职责，读取现有 `ZCODE_ENV=test|production`。
显式环境变量优先；未设置时读取仓库现有 .env 环境文件，再默认 test。
`NODE_ENV` 只影响读取哪组 .env 文件，不直接决定产品环境。非法非空 ZCODE_ENV 报错。

| 产品环境   | 仓库源文件                              |
| ---------- | --------------------------------------- |
| production | config/provider/zcode-builtin.json      |
| test       | config/provider/zcode-builtin.test.json |

两份都是完整 Release。生产文件是唯一编辑源，测试文件由
`pnpm provider:config:sync-test` 生成并提交，revision 跟随生产文件。
`pnpm provider:config:check-test` 只检查生成结果是否过期，不写文件；纳入单测。
不更改 Release Schema、个人 Overlay、Registry 或账号／模型选择。

## 测试配置的生成规则（Todo147）

对照 `staging_backup@790884b1ce`，仅转换 `zhipu-account` Provider 的以下模型地址：

| 生产 Base URL                                  | 测试 Base URL                                          |
| ---------------------------------------------- | ------------------------------------------------------ |
| https://api.z.ai/api/anthropic                 | https://api.z.ai/api/anthropic                 |
| https://open.bigmodel.cn/api/anthropic         | https://open.bigmodel.cn/api/anthropic                  |
| https://zcode.z.ai/api/v1/zcode-plan/anthropic | https://zcode.z.ai/api/v1/zcode-plan/anthropic |
| https://zcode.z.ai/api/v1/off-peak/anthropic   | https://zcode.z.ai/api/v1/off-peak/anthropic   |

- 每次从完整生产配置重新生成，不增量修改旧测试配置，不维护第二份模型能力。
- 手动模板、第三方地址、Key 管理链接等字段原样保留；新增未知账号地址时明确失败，要求补充映射，不偷偷请求生产。
- 对命中上述生产地址的站点规则，保留原规则并在其后生成测试 URL 对应规则。
  一条规则只描述一个站点，模型匹配、API 类型、能力、Map 和相对顺序全部继承。
  保留生产规则是因为测试包里的手动 API 模板仍指向生产官方入口。
- 完整 Release 校验后才写生成文件；无网络、无用户数据迁移、无在线发布。
- 构建仍只读取选定文件，不在并行构建时隐式重写源文件；先同步再构建，沿用 Todo146 缓存输入。

```text
编辑生产 JSON → 同步脚本（账号 URL 映射 + 派生站点规则）→ 测试 JSON
                       ↓ 校验生成结果
                  原双环境打包流程
```

签名准入另外在现有 Adapter 增加 `api.z.ai`、`zcode.z.ai` 精确 hostname，
`bigmodel.cn` 已由既有 `*.bigmodel.cn` 覆盖。不扩大到整个 `*.z.ai`，
也不改变公共 Family 分类工具的其他消费者。与产品环境开关无关，仅依实际 URL 判断。
账号 Start／Off-Peak 的不签名例外优先于域名；个人／团队及显式套餐 Key 继续走原入口。

```text
ZCODE_ENV + 对应完整 JSON
             |
             v
共同构建入口：选文件、完整 Release 解码校验
             |
       +-----+--------------------+
       |                          |
       v                          v
Desktop / CLI / SEA 资源     HTTP / Remote / Server CLI 嵌入常量
       |                          |
       +------------+-------------+
                    v
          原有 Built-in Source / Registry
```

Desktop 资源仍为 `resources/config/provider/zcode-builtin.json`；CLI 为
`dist/provider/zcode-builtin.json`；SEA key 仍为 `zcode-provider/zcode-builtin.json`。
Server 保持原有 JSON 编译常量。开发态 Desktop 根据同一个编译环境定位仓库源文件。
显式配置路径注入优先级不变。

读取／解析失败直接终止构建，禁止跨环境 fallback。复用现有 Release 解码器，
不维护第二份 Schema。构建工具只做本地文件读取，不联网下载配置。

跨平台加载 Release 解码器时，必须将文件系统路径转换为 `file:` URL 后交给
`tsImport`，避免 Windows 盘符被 ESM loader 识别为协议。两种环境共用这一入口，
不改变配置选择、校验和禁止跨环境 fallback 的策略。

## 缓存与时序

- 普通 CLI、Desktop、Server 构建仍按原流程执行，不新增缓存层。
- bootstrap 已有 JS 可以继续复用，但仍验证并刷新旁边的配置资源。
- Turbo 的 CLI build 与 build:desktop-agent 包含 ZCODE_ENV、相关 .env、两份配置及公共构建工具。
- Desktop E2E 构建指纹包含公共工具与配置输入；已有环境指纹继续复用。
- 远程 Server 已将配置嵌入 JS；现有 source hash / artifact hash 自然使配置变化触发重新打包。
- 不通过覆写仓库源文件选择环境；不同环境并行构建须使用各自 worktree／输出目录，
  不新增对同一个 dist 的并发写入保证。

线上配置发布、revision/LKG 选择和 endpoint 隔离不变：本次只决定包内初始配置。
桌面 continuous 和手机 shared-host/replayable 链路无状态、协议或执行权变更。

## 验证

用内容不同的临时 Release 区分环境，覆盖缺失／坏 JSON／坏 Schema、环境优先级、
复用 JS 后刷新、同环境内容更新、SEA 资源及最终嵌入产物。真实两份配置分别解码。
不以“当前两份相同所以测试通过”代替环境选择断言，不要求真实模型请求。

公共构建入口测试与测试环境配置同步测试分文件维护：`builtin-provider-build.test.ts`
只运行公共构建契约；`builtin-provider-test-config-sync.test.ts` 运行内部同步脚本的 Node 测试。
后者与同步脚本及其脚本测试一起按文件排除，公共构建测试在开源导出时原样保留，
不通过补丁删除参数化用例，也不以缺文件时跳过代替闭源侧验证。
