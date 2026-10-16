# Bash Command Permission Registry Design

## 背景

当前项目级 Bash “始终允许”把完整 `input.command` 写成 permission rule。即使规则使用
`:*` 后缀，匹配仍发生在原始字符串上，既不能稳定复用 `pnpm run lint --fix` 与
`pnpm run lint --reporter=dot` 的共同 action，也可能让 `npm run:*` 误覆盖
`npm run test && rm -rf ...`。

本设计区分两类独立 registry，不混淆它们的职责：

- command prefix registry：由 `@withfig/autocomplete` specs 和内置 override 提供命令、
  subcommand、option 参数形状，用于寻找稳定 action prefix；
- Bash readonly policy：判断 invocation 是否可自动只读放行，继续由 ZCode 现有
  data-driven Bash policy 负责。

prefix registry 不能把命令变成只读；readonly registry 也不能决定持久化授权范围。

## 目标与非目标

目标：

- 把 Bash 项目级授权从完整命令字符串升级为 AST 感知的稳定 command prefix；
- compound command 的每个需审批 invocation 分别判断，不能借一个已授权前缀执行追加命令；
- suggestion 成为 durable permission fact，桌面、手机 replay、刷新恢复和 TUI 展示一致；
- 沿用 `permission/ruleset` JSON 和 `PermissionRuleValue`，不新增 SQL migration；
- 保留旧 exact、`:*`、wildcard 和 tool-only rule 的读取兼容，不批量扩权。

非目标：

- 不使用 LLM 提取 prefix；
- 不新增 session/global permission scope；
- 不提供权限规则管理页或可编辑 pattern input；
- 不把 Fig package 或 specs 带入 CLI 运行时；
- 本轮不实现手机真实网络 E2E，也不改变 desktop continuous 与 mobile replayable 的边界。

## 总体数据流

```text
build/dev only
@withfig/autocomplete@2.692.3
        |
        v
deterministic generator ---> compact generated registry ---> zcode.cjs / SEA
                                  |
runtime                           v
Bash input ---> unbash AST ---> permission rule policy
                                  | evaluator + suggestions
                                  v
PermissionService ---> permission.requested durable event
                                  |
              +-------------------+--------------------+
              |                   |                    |
              v                   v                    v
 desktop-continuous       web-remote-replayable   TUI approval
 PermissionDialog         snapshot / gap restore  read-only scopes
              |                   |                    |
              +-------------------+--------------------+
                                  |
                                  v
                    option.response.permissionUpdates
                                  |
                                  v
              local_setting(permission/ruleset JSON)
```

relay、desktop main、host bridge 和 UI 只透传或展示 suggestion，不重新解析 Bash。手机
`/remote` 继续 attach 桌面已有 shared host；permission snapshot 仍由 host runtime 持有，
不把业务状态下沉到 relay/main，也不把 replayable 恢复拼入 desktop continuous 主链路。

## 构建期 Registry

### 输入与输出

生成期精确固定 `@withfig/autocomplete@2.692.3`。generator 遍历 Fig root specs，只保留：

- command/subcommand 名称和 aliases；
- option 是否消费参数；
- argument 的 `isCommand`、`isModule`、`isVariadic`、`isOptional`、`isDangerous`；
- file/folder path template 信息。

生成物使用紧凑 tuple/短字段编码，排序稳定、不写时间戳，头部记录 Fig 版本、输入内容
hash、跳过统计和 ISC attribution。`registry:check` 在临时目录重新生成后逐字节比较，且检查
未压缩生成物不超过 3 MiB。CLI bundle、desktop-agent 与 SEA 测试必须证明运行时不读取
Fig package文件。

内置 policy 补齐 wrapper specs、递归限制和 depth overrides，包括 `git push`、
`docker`、`kubectl`、`aws`、`az`、`gcloud` 等不能仅靠通用 spec 深度推导的 action 边界。

### Prefix resolver

resolver 复用 `unbash` AST，不对 raw string 做 shell token 猜测：

1. 只处理可安全枚举的 invocation；解析失败、redirect、command/process substitution、
   subshell、函数、循环、条件、case、here-doc 或未知动态节点回退整串 exact。
2. 已知全局 option 按 registry 跳过自身及参数，再寻找 subcommand；path、URL 和普通文件
   参数不进入 prefix。
3. wrapper 最多两层，解析递归总深度最多十层。保存的 prefix 保留 wrapper 和用户原始
   executable token；仅 registry lookup 可使用 basename，不能把绝对路径静默统一扩权。
4. 静态 env assignment 只有在 name/value 都可无歧义证明时保留；动态或未知 assignment
   回退 exact。
5. shell interpreter、删除/权限修改等高风险命令没有稳定 action 边界时回退 exact。
6. 任一 prefix token 含空白或不能无歧义序列化时回退 exact。

稳定 prefix 继续存成 `ruleContent: "<prefix>:*"`。exact 保存 trim 后的完整 raw command。
compound command 保存多条独立 rule，不合并最长公共前缀，最多五条；超过上限回退整串
exact。由 readonly policy 已自动允许的 invocation 不生成冗余持久 rule。

## Permission Rule Policy

`ToolEntry` 增加可选 `resolvePermissionRulePolicy(input, runtimeContext)`，返回：

- 针对整组 allow/ask/deny rules 的 evaluator；
- 本次项目级允许建议的 `PermissionUpdate[]`。

`PermissionService` 仍然工具无关。没有自定义 evaluator 的工具沿用 exact/wildcard 逻辑；
Bash evaluator 先检查完整 raw exact，再在 AST 安全时按 invocation 做 token-boundary
prefix/wildcard 匹配。

```text
ruleset priority
  deny: any required invocation matched -> deny
   ask: any required invocation matched -> ask
  plan: existing plan-mode precedence
 allow: every required invocation covered -> allow
  else: ask
```

安全不变量：

- `npm run:*` 可匹配单一 `npm run test --watch` invocation，但不能吞掉
  `npm run test && rm -rf ...`；
- 多条 allow rule 可以共同覆盖 compound 的多个 invocation；少一条仍需询问；
- deny/ask 任一 invocation 命中即生效；
- readonly invocation 视为已覆盖，但不会生成 suggestion；
- AST unsafe 时 prefix/wildcard 不参与放行，完整 raw exact 仍可命中；
- tool-only 历史 rule 保持原有全工具授权语义；
- plan-mode precedence 不因 Bash evaluator 改变。

## Durable suggestion 与协议

`suggestedPermissionUpdates?: PermissionUpdate[]` 加入：

- `PermissionBrokerRequest`；
- `PermissionRequestedPayload`；
- `PendingPermission`。

suggestion 在进入 broker 前计算，并与 `permission.requested` durable event 一起写入。v4
permission option 增加可选原始 `response`；新 snapshot 原样携带 allow-project response，旧
snapshot 没有 `response` 时仍按 option kind 映射 allow/deny，并为旧 pending Bash request
生成 exact suggestion。`buildProtocolPermissionOptions`、desktop 和 TUI 不再自行从 input
推导规则。

## 存储与历史兼容

不新增表、不升级 SQL migration、不修改 `local_setting.schema_version`：

- 继续写 project scope 下 `namespace=permission`、`key=ruleset` 的 JSON；
- `PermissionRuleValue` 保持 `toolName + ruleContent`；
- ruleset version 保持现值；
- 旧 exact 原样保留并优先按完整 raw 匹配；
- 旧 `:*` 和 wildcard 对 Bash 改走 AST-safe evaluator，不再 raw startsWith compound；
- tool-only rule 维持历史语义；
- ruleset 只在用户新增授权时通过现有路径重写，不批量迁移、不静默扩大历史授权；
- `0003_backfill_permission_local_setting` 的既有结果不改写。

## UI 与 TUI

桌面 `PermissionDialog` 在“始终允许此项目”选项下只读展示一至五条 prefix scope：

- prefix：用 `pnpm run lint …` 直接替换“后续相同命令不再询问”辅助文案，不再额外展示
  “命令前缀”标签或带边框容器；多个 prefix 逐行展示，窄屏和超长连续文本均可自然换行；
- exact：不在授权选项内重复展示“仅此命令”卡片；实际命令由上方工具预览展示，完整
  `ruleContent` 仅保留在 option response 中用于应答与持久化，不写入 scope DOM、`title`
  或 ARIA 文案；
- compound：多个 prefix 逐行展示，不合并；exact invocation 不重复展示；
- 使用 monospace、现有语义色和 popover/input tokens，兼容亮/暗主题及手机宽度；任何单条
  scope 的展示文本必须有固定字符上限，不能让 here-doc、内联脚本或生成内容撑高权限选项。

不增加自由编辑输入，保留 optionId、数字快捷键、方向键和焦点行为。所有现有 locale 增加
scope 文案。TUI 展示相同只读列表，并直接返回 request 携带的 suggestion。

## 覆盖与剪枝

- `BPR01`：稳定 prefix 显示、持久化和不同 transient args 复用；
- `BPR02`：sibling action 与 compound 部分覆盖仍询问；
- `BPR03`：dynamic/redirect/parse failure 等 exact fallback；
- `BPR04`：legacy exact、`:*`、wildcard、tool-only 与数据库重开兼容；
- `BPR05`：durable event、refresh/snapshot/replay 与 allow-project response 无损；
- `BPR06`：TUI 与 desktop suggestion/response 一致。

正式桌面 E2E 用一条 `pnpm run <script>` 代表 BPR01/BPR02 的用户闭环，并扩展现有
refresh-permission case 代表 BPR05。compound、历史 DB、TUI、registry/build 使用确定性单元
或集成测试，不注入脆弱 GUI 状态。本轮剪枝手机真实网络 E2E：以 v4 schema、projection 和
replay snapshot 测试证明字段无损，不能据此声称 mobile shared-host 真实网络链路已覆盖。

## 日志与隐私

生产日志只允许记录 registry 版本、生成结果类别和 rule 数量。禁止记录原始 command、完整
`ruleContent` 或 scope 文本；高频解析细节只能使用开发态 `debug`，且同样避免输出敏感参数。
