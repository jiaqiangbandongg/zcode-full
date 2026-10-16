# Todo 41：Built-in Provider 主推模型与属性刷新

> 状态：完成
>
> 证据：[`builtin-provider-model-evidence-2026-08.md`](../research/builtin-provider-model-evidence-2026-08.md)
>
> 后续校正：本 Todo 当时关于 MiniMax M3 “官方 Endpoint 未确认、默认关闭”的判断，已由当前官方模型调用
> 文档推翻；最终结论与 revision 4 见 [`Todo 43`](./todo-43-models-api-evidence-and-minimax-m3-correction.md)。

## 1. 目标

基于 2026-08 当前厂商官网、搜索发现和已确认的 ZCode 产品事实，把
`config/provider/zcode-builtin.json` 升级为 revision 3：补齐当前主推/独特模型，校正确定能力，使用
Provider-Model Exact Rule 表达默认 enabled，并让 Provider 成员物理顺序与 enabled 区一致。

本轮接受保守但不完美的结果；不把未经验证的猜测写成开启状态。后续用独立模型验证 API 继续校准。

## 2. 影响简报

### 2.1 变更分类

- `option-source`：Built-in Provider Map 与 Built-in Model Config Rules。
- `draft-default`：设置页新增/编辑模型看到的 Effective Model 默认事实。
- `validation`：Registry 完整性、Adapter compatibility 与媒体/请求能力校验。
- `persistence`：发布 revision 变化；Personal Overlay 的存储结构不变。

### 2.2 状态与执行链

```text
Built-in revision 3
├─ Provider members / initial order
└─ Model Config Rules / exact enabled
              |
              v
Account Overlay
              |
              v
Personal Overlay
              |
              v
Effective Provider + Effective Model Config
              |
              v
Registry -> Active Model -> Adapter
```

不改变 Session Selection、队列、Compact、Memory、Subagent、Desktop continuous、Mobile replayable 或
workspace identity。Active Model 仍冻结本轮创建时的 Effective Model Config。

### 2.3 主要实现种子

- `config/provider/zcode-builtin.json`
- `packages/provider-node/test/zcode-builtin-integrity.test.ts`
- `docs/working-memory/provider-refactor/design/registry/zcode-builtin-provider-config.md`
- `docs/working-memory/provider-refactor/research/account-provider-and-builtin-config-review.md`

当前环境没有可调用的 codegraph 工具；本轮以正式 Config、Resolver 完整性测试、Feature Graph 现有
`capability.provider-registry` 不变量和 `rg` 引用审计替代。没有发现需要改变状态所有权或异步链路。

## 3. 决策

1. 普通 Account API 的 `glm-5.3` 保持 Text-only；不报错不是视觉证据。
2. Plan Provider 继续通过 Provider-scoped Match Rule 为实际成员提供 Image/Video。
3. Individual/Team 加入 `GLM-5.3`，固定顺序为 5.3、5.3 Flash、5.2、5-Turbo。
4. Start 成员仍由 Account 上游约束，本轮不静态扩大。
5. 新增 Kimi K2.7 Code、Qwen 3.8 Max/Flash；补 MiMo v2.5 Audio 静态事实。
6. 当时把 MiniMax M3 视为未确认候选并默认关闭；该历史判断已由 Todo 43 校正，不再作为当前维护依据。
7. 默认 enabled 使用现有 `provider-model` Exact Rule；不新增优先级、排序器或第三种 Rule。
8. `supportsStructuredOutput` 改名属于 Todo 39；本轮只按“严格 JSON Schema”语义保守修事实，不混入字段迁移。

## 4. 测试先行

先扩展真实 Built-in 完整性测试，使 revision 2 失败：

- revision 为 3；
- Individual/Team 四个 Provider 的成员顺序与 Plan Image/Video；
- 普通 API 的 5.3 Text-only、5.3 Flash Image/Video；
- 各厂商主推成员存在、关键 context/max output/media 属性正确；
- 每个 Provider 的 enabled 模型在 `builtinModelIds` 中形成连续前缀；
- 被替代/alias/未证明候选默认 disabled；
- 每个 Built-in 成员都由该 Provider 的 Exact Rule 明确给出 enabled；
- Resolver 补齐访问材料后仍零 issue，Registry 成员顺序与文件一致。

然后最小修改 Built-in Config 使测试通过。不得在生产代码新增 modelId/Provider ID hardcode。

## 5. 验证与验收

1. `pnpm --filter @zcode/provider-node test`
2. `pnpm --filter @zcode/provider-node typecheck`
3. `pnpm --filter @zcode/provider test` 与 typecheck
4. `pnpm typecheck`
5. `pnpm lint`
6. 相关格式检查、`git diff --check`
7. 搜索确认没有旧远端模型事实、运行时 modelId hardcode 或第二套能力 DTO。

本轮没有 UI 交互代码变化，因此不新增 Desktop E2E；设置页与选择器通过现有 Registry 投影读取 revision 3，
只做不变量回归。提交时只暂存 Todo 41、证据/设计文档、Built-in Config 与对应测试，保留工作区其他任务改动。

## 6. 实施记录

- Built-in Config 已升级到 revision 3：21 个 Provider、131 条 Match Rule、179 条 Provider-Model Exact Rule。
- Individual/Team 已加入 GLM-5.3；普通 Account API 与 Plan 视觉事实已分离。
- 已加入 Kimi K2.7 Code、Qwen 3.8 Max/Flash，并补齐 MiMo v2.5 Audio 静态事实。
- DeepSeek/Qwen 旧规则不再把 JSON Object 冒充严格 Schema；DeepSeek 官方 Responses Endpoint 单独晋升。
- 所有 Built-in 成员均有唯一 Exact enabled，且 enabled 成员形成 `builtinModelIds` 的连续前缀。
- 验证通过：Provider/Provider Node 定向测试与 typecheck、Provider Runtime 测试、根 typecheck、根 lint
  （仅仓库既有 warning）、全量 unit（1492 files passed，12730 tests passed）。
