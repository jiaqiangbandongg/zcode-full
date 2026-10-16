# Conversation Session Manual Review E2E

`manual-review/pending/` 保存尚未完成人工产品预期确认的 conversation case。

> **V4 formal gate 清理（2026-07-11，Task 2）**：又有 32 个实际调用
> `prepareConversationE2E()` 的 legacy formal spec 原样移动到 `pending/`，没有删除或改写
> 业务断言。当前 conversation-session 共 121 个 spec：formal 29 个、pending 92 个；
> formal 已不再精确导入旧聚合 helper，也不再调用 `prepareConversationE2E()`。
> 这 32 个 moved spec 只保留为后续按领域迁移的语料和人工 review 入口，不是当前 V4
> formal 门禁证据。

> **v4 硬切降级标记（2026-07-05，删波次 1）**：原主目录的全部 41 个门禁 spec 已整体迁入 `pending/`。
> 原因：v4 竖切后旧 UI（`ChatView` / `TID_CHAT_*` testid）已删除，这些 spec 的 DOM 断言全部失效；
> 按 `docs/v4-refactor/11-deletion-plan.md` 的处置，case 的产品语义仍以
> `docs/conversation-session-case-catalog.md` 为权威，M4 期间按 catalog 逐条以
> v4 testid（`TID_V4_*`，见 `packages/shared/src/test-ids.ts`）重写后移回主目录，coverage matrix 证据同步重建。

这些 spec 的职责是自动执行用户路径、留下 UI / network / log / session artifact，方便人工逐条 review。它们不属于默认 conversation 质量门禁；review 完成并补齐确定性断言后，再把对应 spec 移回 `packages/desktop/test/e2e/conversation-session/`。

转正流程和 fixture 目录约定见 `docs/testing/conversation-session-e2e-development-workflow.md`。

人工 review 默认标准：除非 case 明确写着要验证 fault / negative / error recovery，否则运行过程中出现 `ChatViewErrorBanner` / `ChatErrorBanner` 就视为该正向 case 不通过。

运行方式：

```bash
ZCODE_E2E_MANUAL_REVIEW=1 pnpm --filter @zcode/desktop test:e2e
```

指定单条：

```bash
ZCODE_E2E_MANUAL_REVIEW=1 pnpm --filter @zcode/desktop test:e2e -- --spec './test/e2e/conversation-session/manual-review/pending/<case>.test.ts'
```

已有 case-local fixture 的 pending spec 可以在转正前执行合同检查：

```bash
pnpm --filter @zcode/desktop e2e:fixture:check -- --spec \
  './test/e2e/conversation-session/manual-review/pending/<case>.test.ts'
```

fixture JSON 的 `spec` 固定指向 `./test/e2e/conversation-session/<case>.test.ts`，表示未来转正后的
canonical formal target，不重复记录当前 pending 路径。已有 case-local fixture 的 pending case 自动走
replay；缺 fixture 的 case 才走 live/capture。正式与 pending 的覆盖率全量入口是仓库根目录的
`pnpm test:e2e:all:coverage`；只有配置了真实 `E2E_PROVIDER_API_KEY` 时，入口才会附带
独立真实 provider smoke，否则会明确跳过该外部环境项。
