# Todo 46：Model 调序视觉连续性与列表边框收口

> 状态：已完成
>
> 日期：2026-08-28
>
> 来源：macOS Provider 设置页手工体验

## 1. 问题

Provider 设置页拖动模型并松手后，模型行会短暂回到旧位置，再跳到目标位置。最终顺序通常能够保存，说明
`modelOrder` 计算和持久化没有丢失；问题发生在 `dnd-kit` 结束临时 transform 与正式 Settings View 确认新
revision 之间。

模型列表底部同时呈现出比行分隔线更粗的边线。该视觉不是产品设计：列表只应有一圈单层外框，模型之间只应有
一条分隔线。

Provider 标题中的启用胶囊经讨论后保持现状。本 Todo 不把它改成 Switch：可编辑 Personal Provider 和由
Account Overlay 决定的只读状态并非完全相同的交互语义，当前状态/操作合一的呈现可继续使用。

## 2. 根因

模型调序当前只在 `InlineEditableProviderCard` 中同步执行一次 `setModels(next)`，但没有像 Provider 调序一样把
用户最新顺序保持为 pending intent，直到正式 Settings View 确认：

```text
Pointer Up
    |
    +--> dnd-kit 清除 transform
    |
    +--> 本地 setModels(next)
    |
    +--> Config 写入 / Registry refresh
    |
    `--> provider prop 更新时无条件 setModels(authoritativeModels)
```

因此一次本地 state 更新不足以覆盖异步确认窗口、旧 View 重投影和连续拖动。Bugfix 02 曾假设 Model 的
`setModels(next)` 已经足够，但当时没有使用受控延迟保存和上游旧 View 重投影验证该结论。

列表样式则把外框与 `divide-y` 同时放在包含 DnD 运行时子树的父容器上。无论实际浏览器如何投影 DnD 的辅助
DOM，边框职责都不够显式；最后一条可见模型行不应依赖“最后一个 DOM child”来决定是否绘制分隔线。

## 3. 目标设计

模型和 Provider 调序复用同一套 UI pending 语义：

```text
Authoritative modelOrder -----------------------+
                                                 |
Drag End --> Pending Model Reorder --------------+--> Rendered Model Order
                    |
                    +--> Settings View 对齐 --> 清除 Pending
                    `--> 保存失败 -----------> 回滚 Authoritative
```

- Personal Config 与 Settings View 继续是持久化和正式读取权威；
- pending 只存在于当前设置页，不进入 Config、Registry、Selection 或 Runtime；
- 上游推来成员相同但顺序仍旧的 Provider View 时，不覆盖 pending；
- 成员变化、Provider/Environment 切换或保存失败时，安全退出 pending；
- 连续拖动按交互顺序保存，旧完成结果不能覆盖最新顺序；
- 模型编辑、启停和删除继续按稳定 Model ID 定位，不能依赖可能变化的显示 index。

列表边框改为明确结构：

```text
List container  -> 单层 rounded outer border
Model row       -> 单层 bottom divider
Last model row  -> no bottom divider
```

## 4. 实施

1. 先补失败测试，覆盖 pending 期间收到旧 authoritative 数组仍保持目标顺序。
2. Model 调序复用 `useOptimisticReorder`，并将可见模型按 `renderedIds` 投影。
3. Model 行的编辑、启停、删除回调使用 Model ID，而不是显示 index。
4. 删除 Model 调序原有的手写 `previous/next/setModels` 回滚分支，避免两套 pending 机制。
5. 列表外框保留单层 border；行分隔改为显式 `border-b` 与最后一行关闭。
6. 增加 Desktop E2E，拖动模型后观测松手至保存确认期间不出现旧顺序。

## 5. 验证

- UI 单测：受控延迟、旧 View 重投影、失败回滚、连续调序、成员变化；
- Provider 设置 E2E：真实 pointer drag 后 DOM 顺序不闪回；
- 边框结构测试：外框一个、最后一行无 divider；
- `@zcode/ui` typecheck 与定向测试；
- Desktop E2E typecheck；
- 根 `pnpm typecheck`、`pnpm lint`、格式检查与 `git diff --check`。

## 6. 实施结果

- Model 调序已复用 Provider 调序现有的 `useOptimisticReorder`，旧 Settings View 在正式 revision
  对齐前不会覆盖用户刚刚松手的目标顺序；保存失败、成员变化和 Provider/Environment 切换仍退出 pending。
- Model 编辑、启停和删除改为按稳定 `modelId` 定位，避免调序期间显示 index 变化导致操作落到错误模型。
- Model 列表移除父容器 `divide-y`，由每行显式承担分隔线，最后一行不画底部分隔线；外框保持单层。
- Provider 启用胶囊保持不变。
- 新增 Desktop E2E `MP-UI-03`，使用真实 pointer drag 并记录 DOM 顺序，防止目标顺序出现后再次闪回旧顺序。

验证结果（2026-08-28）：

- `pnpm exec vitest run packages/ui/test/modelProviderModelRowEditor.test.ts packages/ui/test/useOptimisticReorder.test.ts`：
  43 项通过；
- `pnpm exec tsc -p packages/ui/tsconfig.json --noEmit`：通过；
- `pnpm --filter @zcode/desktop typecheck:e2e`：通过；
- `pnpm typecheck`：通过；
- `pnpm lint`：0 error，33 个既存 warning；
- 修改文件经 `oxfmt --write` 且 `git diff --check` 通过；全仓 `pnpm fmt:check` 仍被 Electron 上游 fiddle
  HTML 与 `apps/zcode-cli/tests/gb2312.js` 的既存解析问题阻断；
- Desktop E2E 已完成生产构建，但当前 Linux 宿主没有 `xvfb-run`，Chromedriver 在测试代码运行前因无 Display
  无法创建 session；用例本身已通过 E2E TypeScript 校验，待有图形环境执行。
