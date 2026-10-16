# Todo 64 实施报告：Provider E2E 真实运行修复

> 状态：已完成
>
> 开始日期：2026-09-02

## 1. 实施基线

- 开始 SHA：`64d48f6eee`
- 本地工作区：独立 worktree
- MacBook Pro 运行目录：`/private/tmp/zcode-todo64-run.SWhC6y`
- 初始证据：55 条具备本地环境条件的 Case 中 43 条通过、12 条失败；Remote SSH 1 条因环境条件阻塞。
- 当前证据：当前受影响清单共 52 条，51 条通过；Remote SSH 1 条因环境条件跳过。初始数量与当前数量的差异来自测试拆分、合并与旧 Case 删除，不把历史数字伪装成当前清单。

本报告只记录真实运行证据与已经执行的修复。计划与裁决边界见
`todo-64-provider-e2e-real-run-repair-closeout.md`。

## 2. 逐项记录

| Case               | 初始状态 | 最早失败点                                                                            | 根因分类            | 处理                                                        | 定向结果 | 分组结果                       |
| ------------------ | -------- | ------------------------------------------------------------------------------------- | ------------------- | ----------------------------------------------------------- | -------- | ------------------------------ |
| MP-UI-01           | 失败     | 测试把名称编辑按钮误当成详情页身份                                                    | test                | 改为断言选中的 Provider 导航身份                            | 通过     | Settings UI 7 通过、1 环境跳过 |
| MP-UI-06           | 失败     | 旧断言把 placeholder 当成 value                                                       | test                | 空 Overlay 断言空 value；显式 `{}` 断言 canonical value     | 通过     | Settings UI 7 通过、1 环境跳过 |
| I08                | 失败     | Helper 错读 `maxOutputTokens.default`，而 GUI 保存正式字段 `.max`                     | helper              | 修正 Personal Rule readiness Helper                         | 通过     | 对应 spec 通过                 |
| Repo Wiki settings | 失败     | Case 附带了非职责范围的无 Provider 断言                                               | test                | 删除该 E2E 断言，空 Ready View 继续由单测覆盖               | 通过     | Repo Wiki spec 通过            |
| Repo Wiki produces | 失败     | 新模型选择只保留身份，丢失 reasoning                                                  | production          | 统一调用 `completeNewModelSelection()` 形成完整 Selection   | 通过     | Repo Wiki spec 通过            |
| OTB08-OTB10        | 失败     | 旧期望重复扣除了 usage anchor 已覆盖的 assistant                                      | fixture/test        | cap 修正为 41,671，并同步 replay Fixture 与文档             | 通过     | Preflight spec 通过            |
| I20                | 失败     | 共享 Helper 断言已删除的 `budget_tokens`；冷启动又发现初始完整 Selection 未落稳定事件 | helper/production   | 删除旧字段断言；创建 Session 后立即持久化初始完整 Selection | 通过     | I20 spec 通过                  |
| I26                | 失败     | Seed 缺少完整 reasoning/readiness 前提                                                | fixture/helper      | 使用完整 Selection seed 并等待 Registry 就绪                | 通过     | Restart Recovery 4/4 通过      |
| I27                | 失败     | 旧期望依赖已删除的 Account-first；Configured Default 路由缺 replay                    | fixture/test        | 断言回退有效 Configured Default，并补 DeepSeek replay       | 通过     | Restart Recovery 4/4 通过      |
| I28                | 失败     | 同 I27                                                                                | fixture/test        | 同 I27                                                      | 通过     | Restart Recovery 4/4 通过      |
| I31                | 失败     | 重复选择当前原生 option 不保证触发事件；另有无消费者 transition state                 | test/residual state | 改为设置页往返保持；删除残余状态和伪 reconciliation         | 通过     | Settings Transition 3/3 通过   |
| QR-E2E-09          | 失败     | 初始失败不可稳定复现，隔离及整份 spec 均通过                                          | isolation           | 不改生产语义                                                | 通过     | Coding Plan/Quota 18/18 通过   |

## 3. 阶段审查

### 阶段 A：共性基础设施

共性 Helper 已收口到当前字段与完整 Selection；没有新增 E2E 专属 Registry、旧 Account API seed或固定模型名推断。配置传播使用现有有界状态等待；Template 创建后保留用户已裁决允许的 2 秒 polling 收尾窗口。

### 阶段 B：Selection Case

Repo Wiki、I26–I28、I31 均按当前 Selection 设计完成。审查确认 Renderer 中没有恢复 Account-first 分支；有效 Configured Default 仍由 Host `preferredSelection` 统一解析。

### 阶段 C：未决根因

MP-UI-01/I08、OTB08–10 和 QR-E2E-09 均取得可复现证据或隔离结论。唯一新发现的生产 Bug 是冷启动 Session 没有稳定持久化初始完整 Selection；已用失败单测固定并修复。没有剩余需要产品裁决的失败。

## 4. 最终审查

- Provider/Selection 抽象：已审查；保留 Active Model 冻结与 Host `preferredSelection` 唯一回退，不新增 Account-first 或模型 ID 特化。
- 旧字段与特化逻辑：已删除本轮暴露的 `budget_tokens` 强制断言、无消费者 transition state 与旧字段 Helper；最终机械搜索结果见提交前验证。
- 定向单测：Core `runtime-persistence.test.ts` 65/65，Bootstrap `transcript-hydration.test.ts` 61/61。
- Desktop E2E typecheck：通过。
- Desktop E2E：当前受影响清单 51 条通过；各分组 artifact 见下节。
- Remote SSH：1 条因目标凭据未配置而跳过；补跑条件是提供真实 SSH E2E 环境，不计作产品通过。
- 根 `typecheck`：通过。
- 根 `lint`：通过，保留仓库既有 35 条 warning，没有 error。
- 全量 Unit：1533 个测试文件通过、1 个跳过；13089 条测试通过、25 条跳过。
- Fixture 校验：Output Token Preflight、Restart Recovery、I08、I20 的 case-local fixture 均通过正式检查；Settings UI 不属于 conversation fixture checker 支持范围。
- 修改文件格式与 `git diff --check`：通过。
- Conversation coverage audit：被既有 Hooks lifecycle fixture ledger 顺序和陈旧生成文档阻塞；与本轮修改文件无重叠，未借 Provider 收口修改无关基线。
- 全仓 `fmt:check`：被既有 vendor/electron 文档非法 HTML 与二进制 `gb2312.js` 阻塞；本轮修改文件均通过 `oxfmt --check`。
- 剩余风险与待裁决项：无 Provider 产品语义未决项；Remote SSH 仍是环境覆盖缺口。以上两项仓库级基线失败已如实保留，不伪装为本轮通过。

## 5. MacBook Pro 真实运行证据

运行方式：

```bash
export PATH="$HOME/.local/share/mise/shims:$HOME/.local/bin:$PATH"
export ZCODE_E2E_SKIP_BUILD=1
pnpm --filter @zcode/desktop test:e2e:serial -- --spec <spec>
```

主要 artifact：

- I20：`.e2e-artifacts/desktop-e2e-20260902-173941-528/summary.md`
- Restart Recovery：`.e2e-artifacts/desktop-e2e-20260902-174156-345/summary.md`
- Settings UI：`.e2e-artifacts/desktop-e2e-20260902-174305-616/summary.md`
- Repo Wiki：`.e2e-artifacts/desktop-e2e-20260902-174423-848/summary.md`
- Output Token Preflight：`.e2e-artifacts/desktop-e2e-20260902-174448-752/summary.md`
- Settings Transition：`.e2e-artifacts/desktop-e2e-20260902-174518-093/summary.md`
- Coding Plan/Quota：`.e2e-artifacts/desktop-e2e-20260902-174556-904/summary.md`
- I08：`.e2e-artifacts/desktop-e2e-20260902-175316-125/summary.md`
- Bot Automation：`.e2e-artifacts/desktop-e2e-20260902-175427-109/summary.md`
- Feishu Interactions：`.e2e-artifacts/desktop-e2e-20260902-175452-547/summary.md`
- Feishu Streaming：`.e2e-artifacts/desktop-e2e-20260902-175517-896/summary.md`
- Upgrade WebView：`.e2e-artifacts/desktop-e2e-20260902-175542-933/summary.md`
- Context Cold Resume：`.e2e-artifacts/desktop-e2e-20260902-175610-538/summary.md`
- Output Token Budget：`.e2e-artifacts/desktop-e2e-20260902-175644-701/summary.md`
- Turbo Recovery：`.e2e-artifacts/desktop-e2e-20260902-175717-490/summary.md`
- Turbo Switch：`.e2e-artifacts/desktop-e2e-20260902-175755-973/summary.md`

以上路径均相对于 MacBook Pro 运行目录。结束提交为本报告所在最终提交，以 `git log` 为准。
