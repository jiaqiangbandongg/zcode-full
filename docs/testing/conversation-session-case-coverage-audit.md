# Conversation Session Case Coverage Audit

目标：把会话区 case 数量和覆盖状态从“人工口头统计”变成可重复的机械检查，避免出现“WDIO 跑绿了，但形式化 catalog 里还有未覆盖 case”的错账。

关联文档：

- 主路径 catalog：[conversation-session-case-catalog.md](../conversation-session-case-catalog.md)
- 主路径覆盖矩阵：[conversation-session-e2e-coverage-matrix.md](./conversation-session-e2e-coverage-matrix.md)
- 外部环境故障 catalog：[conversation-session-environment-fault-catalog.md](./conversation-session-environment-fault-catalog.md)
- 外部环境故障覆盖矩阵：[conversation-session-fault-e2e-coverage-matrix.md](./conversation-session-fault-e2e-coverage-matrix.md)
- 待决策 backlog：[conversation-session-decision-backlog.md](./conversation-session-decision-backlog.md)
- 待决策 E2E 路线图：[conversation-session-decision-e2e-roadmap.md](./conversation-session-decision-e2e-roadmap.md)
- 待决策 review 队列：[conversation-session-decision-review-queue.md](./conversation-session-decision-review-queue.md)
- 下一批待决策 review：[conversation-session-next-decision-review.md](./conversation-session-next-decision-review.md)
- 下一批产品决策回答模板：[conversation-session-next-decision-answer-template.md](./conversation-session-next-decision-answer-template.md)
- 产品决策回答草稿：[conversation-session-decision-answers.md](./conversation-session-decision-answers.md)
- 产品决策回答状态：[conversation-session-decision-answers-status.md](./conversation-session-decision-answers-status.md)
- 产品决策回写计划：[conversation-session-decision-backfill-plan.md](./conversation-session-decision-backfill-plan.md)
- 产品决策工作流状态板：[conversation-session-decision-workflow-board.md](./conversation-session-decision-workflow-board.md)

## 机械口径

脚本：`scripts/audit-conversation-session-case-coverage.mjs`

运行边界：该审计用于 E2E case 规划、转正和覆盖盘点时显式执行，不挂入默认 `pnpm test` / `verify:pre-push`。原因是它会校验 catalog、coverage matrix、roadmap 与生成 Markdown 的即时统计；这些文件在一次 E2E 变更过程中常常分阶段更新，放进普通单测会让每次提交都承受过严的过程态门禁。

命令：

```bash
node scripts/audit-conversation-session-case-coverage.mjs --check
```

完成门禁：

```bash
node scripts/audit-conversation-session-case-coverage.mjs --check --require-complete
pnpm audit:conversation-session-complete
```

普通 `--check` 只证明 catalog、覆盖矩阵、待决策 backlog、worksheet、回答草稿和生成文档之间的统计口径一致；它可以在“还差产品决策”的阶段保持通过。`--require-complete` 才是最终覆盖门禁：只要还有 `undefined` / `decision-needed` 产品 case、missing accepted case，或 decision roadmap 仍停在 `blocked-by-product-decision`，该命令必须失败。

生成给产品逐条 review 的 Markdown 队列：

```bash
node scripts/audit-conversation-session-case-coverage.mjs --check --review-queue-md
```

只生成下一批 review：

```bash
node scripts/audit-conversation-session-case-coverage.mjs --check --review-next-md
```

只生成指定 case 或队列前 N 个：

```bash
node scripts/audit-conversation-session-case-coverage.mjs --check --review-queue-md --review-case F09
node scripts/audit-conversation-session-case-coverage.mjs --check --review-queue-md --review-limit 3
```

生成给产品直接填写的回答模板，默认使用下一批 review：

```bash
node scripts/audit-conversation-session-case-coverage.mjs --check --answer-template-md
node scripts/audit-conversation-session-case-coverage.mjs --check --answer-template-md --review-case F09
```

检查 answers 草稿哪些 case 已经填齐、哪些还缺答案：

```bash
node scripts/audit-conversation-session-case-coverage.mjs --check --answers-status-md
```

生成已经填齐 case 的回写计划：

```bash
node scripts/audit-conversation-session-case-coverage.mjs --check --backfill-plan-md
node scripts/audit-conversation-session-case-coverage.mjs --check --backfill-patch-md
node scripts/audit-conversation-session-case-coverage.mjs --check --backfill-json
```

使用临时 answers 草稿预览回写计划：

```bash
node scripts/audit-conversation-session-case-coverage.mjs --check --answers-path /tmp/conversation-session-decision-answers.md --backfill-plan-md
node scripts/audit-conversation-session-case-coverage.mjs --check --answers-path /tmp/conversation-session-decision-answers.md --backfill-patch-md
node scripts/audit-conversation-session-case-coverage.mjs --check --answers-path /tmp/conversation-session-decision-answers.md --backfill-json
node scripts/audit-conversation-session-case-coverage.mjs --check --answers-path /tmp/conversation-session-decision-answers.md --require-backfill-clean
```

`--answers-path` 只替换本次审计读取的产品答案来源，适合在不污染真实 [conversation-session-decision-answers.md](./conversation-session-decision-answers.md) 的情况下预演某个 case 填完后的回写动作。`--backfill-plan-md`、`--backfill-patch-md` 和 `--backfill-json` 输出同一份回写计划的不同视角：`--backfill-plan-md` 按 case 展开，`--backfill-patch-md` 按文件展开，`--backfill-json` 给后续自动化消费。回写计划包含 ready case、产品结论、source status、roadmap status、建议 E2E spec 和四步回写动作。每个 ready case 还会带精确 target：`worksheetTargets` 指向协议题行，`sourceTargets` 指向 catalog / coverage matrix 的 case 行，`roadmapTarget` 指向 decision E2E roadmap 行，`e2eTarget` 指向建议 spec；target 会携带当前 `line` 和 `current` 值，作为后续自动 patch 前的防误改锚点。可替换的 Markdown 表格 target 还会在 JSON 中携带 `expectedLine` 与 `replacementLine`：前者是当前文件中的整行内容，后者是填入产品结论后的整行预览，后续自动回填必须先比对 `expectedLine` 再替换，避免把并发修改覆盖掉。`--backfill-json` 还会额外输出按文件聚合的 `patchPlan`，把所有可替换行集中到 `files[].replacements`，把待创建或更新的 E2E spec 集中到 `files[].createOrUpdate`，方便后续做自动回填或生成 diff；`--backfill-patch-md` 则把同一份 `patchPlan` 渲染成可人工 review 的表格。真实 answers 文件默认要求 backfill clean：只要某个 case 已经填齐答案但 worksheet / source coverage 还没回写，`--check` 就会失败；自定义 `--answers-path` 默认只预演，不触发该失败，除非显式加 `--require-backfill-clean`。使用自定义 answers path 时，脚本不会检查仓库里的生成 Markdown 是否 stale，因为生成文档只以 canonical answers 文件为准。

生成把 answer draft / worksheet / source coverage / roadmap 串在一起的工作流状态板：

```bash
node scripts/audit-conversation-session-case-coverage.mjs --check --workflow-board-md
```

## V4 formal admission 机械边界

历史 `A-J` coverage 统计回答“产品 case 曾有哪些自动化证据”；V4 formal admission
回答“当前默认 formal 目录中的 spec 是否具备完整、可独立回放的合同”。两组统计彼此独立：
spec 通过 admission 不会自动把 coverage 状态提升为 `covered`，pending legacy 证据也不会进入
当前 formal admission 数量。

可复用 inspector 位于
`scripts/lib/conversation-session-formal-admission.mjs`。它只把
`packages/desktop/test/e2e/conversation-session/*.test.ts` 的 direct-root spec 送入
formal 门禁；`manual-review/**` 递归统计为 pending，但其中的 legacy helper 不会让
formal 门禁失败：

```text
conversation-session/*.test.ts
        |
        v
legacy + manifest + provider/file path + request ledger audit
        |
        +--> admitted ----------> formalAdmission.formal.admitted
        |
        +--> rejected ----------> --check nonzero + exact file/reason

conversation-session/manual-review/**/*.test.ts
        |
        +--> pending inventory --> 不进入 admitted/rejected
```

每个 direct-root formal spec 必须满足：

1. TypeScript AST 中不能出现精确指向 `helpers/conversation-session.js` 的
   `ImportDeclaration`，也不能出现 callee 为 identifier `prepareConversationE2E` 的
   `CallExpression`。文档字符串里的旧 import 不会误报，template expression 内的真实 call
   仍会被发现；parenthesized、non-null、`as`、type assertion、`satisfies` 等透明 wrapper
   会先递归 unwrap。审计不会粗略禁止所有 `TID_CHAT_*`；V4 仍可复用有效的
   tool/history/toolbar/summary test id。
2. case manifest 与 case-local provider fixture 都存在；manifest 是 version 1，且
   `caseName`、`spec` 必须精确指回当前 formal spec。
3. manifest 必须声明 case-local provider fixture。provider path 必须是无 traversal 的相对
   路径且 containment 在 desktop DeepSeek fixture root；静态 file fixture 同样必须 containment
   在 desktop fixture root，absolute 或 `..` 路径直接拒绝。对已存在路径还会比较 root 与
   candidate 的 `realpath`，因此 root 内 symlink 不能逃逸到外部；不存在的路径继续报告
   missing。运行时 file descriptor 只有同时
   提供非空 `path`、`description`，且 `source` 属于
   `created-by-spec` / `created-by-helper` / `created-by-provider-tool` 时才豁免存在检查。
4. `providerRequestPolicy: "none"` 只能搭配空 `requests`；manifest 或 provider fixture
   中 source/kind 为 `synthetic` 的请求必须有非空 `syntheticReason`。反向也成立：
   case-local fixture 与 requests 同时为空时必须显式声明 policy `none`，不能把漏合同当纯 UI。
5. provider fixture 必须是 version 1 + fixtures array；每项必须有非空 `id` 和 object
   `match` / `response` / `metadata`，metadata 必须完整声明 kind/source/timing policy。
6. manifest ledger 必须完整覆盖 case-local fixture 的 request id，保持相同数组顺序，
   并逐项精确匹配 `kind`、`source`、`timingPolicy`、`syntheticReason`。额外 common request
   只允许来自 canonical `upstream/common.json` 且 fixture `metadata.kind=common`；其它
   provider/other-case fixture 不能冒充 common，manifest duplicate request id 也会拒绝。

focused inspector 测试使用真实临时目录和真实 JSON/文件解析：

```bash
node --test scripts/test/conversation-session-formal-admission*.test.mjs
```

`conversation-session-formal-admission-audit.test.mjs` 会 spawn 实际 audit CLI，验证 JSON/text
输出、精确 error 与 nonzero exit。它通过受控环境变量
`ZCODE_CONVERSATION_SESSION_FORMAL_ADMISSION_ROOT` 只替换 inspector 的 synthetic root；该变量
仅在子进程继承 Node test runner 的 `NODE_TEST_CONTEXT` 时可用，单独设置 `NODE_ENV=test` 会
以 test-only 错误退出。catalog、coverage matrix 与所有其它 docs root 仍固定读取真实仓库，
不会修改真实 formal 目录。

`--json` 在 `formalAdmission` 下输出完整 inventory。稳定的统计字段位于
`formalAdmission.counts`：

```json
{
  "formalAdmitted": 29,
  "formalRejected": 0,
  "pending": 92,
  "missingManifest": 0,
  "missingFixture": 0,
  "legacyHarness": 89,
  "legacyHarnessFormal": 0,
  "legacyHarnessPending": 89
}
```

被拒绝项位于 `formalAdmission.formal.rejected[]`。每项包含 repo-relative `specPath`、
`caseName` 与 `reasons[]`；每个 reason 的 schema 为
`{ code, message, specPath, subjectPath }`。因此 `--check` 会用稳定 reason code 和精确
spec/manifest/fixture 路径失败，而不是只给汇总数字。

`--check` 会在这些情况失败：

- direct-root formal spec 被 admission inspector 拒绝，包括 legacy helper、manifest /
  case-local fixture 缺失或身份错误、声明路径缺失、provider policy / synthetic reason
  违规，或 manifest 与 case-local fixture 的 request id / 顺序 / metadata 不完全一致。

- `A-J` 主路径 case 在 catalog 和 coverage matrix 之间缺失或多出。
- catalog 中 `accepted` case 在 coverage matrix 中没有覆盖状态。
- catalog 中 `undefined` case 在 coverage matrix 中被错误写成非 `undefined`。
- coverage matrix 中 `covered` / `failing` / `partial` case 没有自动化缩写，或缩写没有在“测试缩写”表中定义。
- “测试缩写”表里的 spec 文件不存在，或没有声明任何 `it(...)` / `test(...)`。
- 被引用的 spec 文件包含 `describe.skip`、`it.skip`、`test.skip`、`describe.only`、`it.only`、`test.only`。
- `undefined` case 填了自动化缩写，导致看起来像已有稳定断言。
- coverage matrix 的“当前统计”表与实际 case 表格不一致。
- environment fault catalog 的“当前统计”表与实际 fault 表格不一致。
- fault coverage matrix 缺少或多出 environment fault catalog 中的产品 fault row。
- fault coverage matrix 中 `covered` / `failing` / `partial` fault case 没有自动化缩写，或缩写没有在 fault “测试缩写”表中定义。
- fault coverage matrix 中 `decision-needed` fault case 填了自动化缩写，导致看起来像已有稳定断言。
- fault coverage matrix 里的 spec 文件不存在、没有声明任何 `it(...)` / `test(...)`，或包含 skip/only。
- fault coverage matrix 的“当前统计”表与实际 fault 覆盖表格不一致。
- `C01-C03` alias 没有对应到主路径 `F09/G11/G12` 这些 undefined case。
- decision backlog 没有完整列出当前所有 `undefined` / `decision-needed` 产品 case，或仍保留了已经不再待决策的 case。
- decision backlog 的“当前统计”表与实际待决策 case 分组不一致。
- decision E2E roadmap 没有完整列出当前所有尚未 `covered` 的 case，仍保留了已经 `covered` 或未知的 case，状态不在允许集合内，或缺少建议 spec / fixture / 观察面。
- decision E2E roadmap 状态和主路径 / fault coverage matrix 状态不一致，例如 coverage 仍是 `decision-needed` 但 roadmap 写成 `ready-to-write`，或 coverage 已是 `missing` 但 roadmap 仍写 `blocked-by-product-decision`。
- decision E2E roadmap 的“当前统计”表与实际 roadmap case 表格不一致。
- 三份 decision worksheet 没有完整覆盖当前全部待决策 case，或 worksheet 中仍保留了已经不再待决策的 case。
- 三份 decision worksheet 没有完整列出当前 40 个待决策 case 的 49 个协议题、协议题状态不是 `answered` / `unanswered`，或“当前统计”表与实际协议题不一致。
- 协议题缺少 `需要确认`、`候选答案摘要/验证关键词` 或 `回写目标`，导致 review queue 只能给出编号，不能直接进入产品确认。
- 协议题 `Status=answered` 但 `产品结论` 仍是空 / `TBD` / `待确认` / `待产品确认`。
- 协议题 `Status=unanswered` 但已经填了非占位 `产品结论`，导致产品结论和状态不一致。
- decision answer draft 中的 question 编号不存在，或同一个 question 出现多次。
- decision answer draft 必须至少为当前 49 个协议题保留可填写占位行；有占位但还没结论会被统计为 `placeholder-only`，真正缺少占位行才会进入 `missing`。
- canonical decision answer draft 中某个 case 已经全部填齐，但 decision worksheet / source coverage 仍未回写；这会阻止“产品已经回答，但覆盖状态仍停留在 blocked”的漏账。自定义 `--answers-path` 只有显式 `--require-backfill-clean` 时才启用同一门禁。
- decision worksheet 中某个 case 已经全部 `answered`，但源 catalog / coverage matrix 仍然停在 `undefined` / `decision-needed`。这表示产品结论已经进入 worksheet，却没有完成源事实回写。
- decision readiness 的 case 集合和 decision backlog 不一致。只有当某个 case 的全部协议题都 `answered` 且有明确 `产品结论` 时，它才会进入 ready；否则保持 blocked。
- decision review queue 会按 backlog 批次排序当前 blocked case，并在 `--json` 输出里带上每个 unanswered question 的问题文本、候选答案/验证关键词和回写目标。它不是产品结论，只是让下一步问题顺序和 review 内容都可重复。
- 由脚本生成的 review queue、next review、answer template、answers status、backfill plan、workflow board 与当前脚本输出不一致，或文件缺失。这样可以避免 case 口径更新后，给产品 review 的文档仍停在旧版本。
- `--require-complete` 打开时，如果合并去重后的 product case 仍有待产品决策 / 自动化，或者 accepted case 没有稳定覆盖，该命令会失败。这个门禁用于最终验收，不能用普通 `--check` 的通过来替代。

## 当前基线

这不是产品完成定义，只是防止统计漂移的基线：

| 指标 | 当前值 |
| --- | ---: |
| 主路径 A-J case | 163 |
| 主路径 accepted | 163 |
| 主路径 undefined | 0 |
| 主路径 covered | 113 |
| 自动化缩写 | 93 |
| 被 coverage matrix 引用的 spec | 62 |
| 有测试声明的 spec | 93 |
| referenced spec skip/only | 0 |
| 新增外部故障 product case | 37 |
| 外部故障 alias | 3 |
| 外部故障 infra case | 4 |
| Fault 覆盖矩阵 row | 40 |
| Fault 覆盖矩阵 covered | 0 |
| Fault 覆盖矩阵 decision-needed | 37 |
| Fault 覆盖矩阵 missing accepted | 3 |
| 待决策 backlog row | 37 |
| 待决策 E2E roadmap row | 87 |
| 待决策 E2E roadmap expected row | 87 |
| 待决策 E2E roadmap blocked-by-product-decision | 37 |
| 待决策 E2E roadmap ready-to-write | 29 |
| 待决策 E2E roadmap implemented | 21 |
| 决策工作单覆盖 row | 37 |
| 协议题总数 | 37 |
| 协议题 answered | 0 |
| 协议题 unanswered | 37 |
| Answer draft row | 37 |
| Answer draft answered | 0 |
| Answer draft pending placeholder | 37 |
| Answer draft missing question row | 0 |
| Answer draft ready-to-backfill case | 0 |
| Answer draft placeholder-only case | 37 |
| Answer draft partial case | 0 |
| Answer draft missing case | 0 |
| Backfill workflow draft-ready case | 0 |
| Backfill workflow worksheet-ready case | 0 |
| Backfill workflow source-backfill-needed case | 0 |
| Decision workflow board case | 37 |
| 决策 ready case | 0 |
| 决策 blocked case | 37 |
| Review queue case | 37 |
| Review queue next | N01, N02, N03 |
| Generated Markdown doc | 6 |
| Generated Markdown stale | 0 |
| Generated Markdown missing | 0 |
| Compact P0 协议题 | 0 |
| Network/SSE 协议题 | 16 |
| Recovery/Isolation 协议题 | 21 |
| 合并去重后 product case | 200 |
| 合并去重后已覆盖 | 113 |
| 合并去重后仍待产品决策 / 自动化 | 87 |
| Completion gate required | no |
| Completion gate coverage complete | no |
| Completion gate covered | 113/200 |
| Completion gate decision-needed | 37 |

以后新增产品语义时，必须先进入 catalog，再让本 audit 报出新的缺口；对应 E2E 或产品决策补齐后，再更新覆盖矩阵。只要某条 case 还不能写稳定断言，它必须同时出现在 decision backlog，方便产品 review 和剪枝。
