# Memory 双分支收敛实施计划

## 1. 当前目标与唯一权威

- 适用请求形态：Anthropic Messages + `mid-conversation-system-2026-04-07`
- 验收对象：最终 provider request body

行为权威顺序固定为：Memory spec → 语义 fixture → 生产 generator/adapter/E2E。旧 capture、历史
Phase 记录和中间 Context 对象不再定义当前行为；历史执行证据由 Git 保留，不在本文件维护第二份 active
contract。

三处行为共用同一个 retrieval 分支开关：Main pointer、AutoMem index 过滤、Selector 启动。

| branch                  | Main pointer | `MEMORY.md` index | Selector | `relevant_memory` |
| ----------------------- | ------------ | ----------------- | -------- | ----------------- |
| `default-index`（当前） | 是           | 加载              | 不启动   | 不注入            |
| `semantic-recall`       | 否           | 不读取            | 启动     | tool batch 后注入 |

```text
PROJECT_MEMORY_SEMANTIC_RECALL_ENABLED = false
                       |
                       v
        resolveProjectMemoryRetrievalBranch()
                       |
          +------------+-------------+
          |                          |
   default-index              semantic-recall
   pointer + index            selector + recall
   no selector                no pointer/index
```

Extraction、Dream handler、foreground 写入、Custom Agent Memory、Settings 总开关和
Desktop/mobile/protocol 边界不参与该 retrieval 分支。

每个 Phase 固定流程：

- [ ] 先重读 spec 和相关实现。
- [ ] 先补失败测试或 provider-visible fixture。
- [ ] 只实现本 Phase 冻结的行为。
- [ ] 运行聚焦测试、typecheck/lint 和 scope self-review。
- [ ] 更新本文件 checklist 与验证证据。
- [ ] 全程不提交 commit。

## 2. Phase 0：spec 与验收权威收敛

- [x] 在 Memory spec 登记双分支矩阵和三处共用的分支开关。
- [x] 明确两组 provider-visible 行为互斥，当前 active branch 为 `default-index`。
- [x] 明确不新增配置、runtime preference、协议、环境变量或测试 setter。
- [x] 更新 MEM01/MEM07 catalog 与 coverage matrix；WDIO 只覆盖当前 default active path。
- [x] 将 fixture metadata 按 `default-index | semantic-recall | both` 标注。
- [x] 将 Main prompt fixture 语义命名为 default 与 semantic 两份。

## 3. Phase 1：唯一 branch 权威与三处接线

- [x] 用 `project-memory-retrieval-branch.ts` 替换只表达单边语义的 `semantic-recall.ts`。
- [x] 原始 `PROJECT_MEMORY_SEMANTIC_RECALL_ENABLED=false` 只在该模块定义一次。
- [x] 增加纯 `resolveProjectMemoryRetrievalBranch(boolean)`，映射为
      `default-index | semantic-recall`。
- [x] 其他生产代码只消费派生的 `ACTIVE_PROJECT_MEMORY_RETRIEVAL_BRANCH`。
- [x] Main prompt：default 有 pointer，semantic 无 pointer，其余文本完全一致。
- [x] Main index：default 才读取、投影并 seed read-state；semantic 在文件 I/O 前跳过。
- [x] Recall lifecycle：semantic 才 start/consume；default 不扫描、不发请求、不注入。
- [x] compact/resume/context refresh 沿用现有 session 初始化语义，不新增 branch state。

Exit criteria：修改唯一 boolean 即可切换三处生产行为，不存在 pointer/index 与 Selector/Recall 同时
启用的路径。

## 4. Phase 2：双分支 fixture、单测与 trajectory

- [x] 新增 `main-memory-default-index.md` 与 `main-memory-semantic-recall.md` exact fixture。
- [x] 保留 `main-memory-index.md`、selector request 与 recalled-memory MCS fixture。
- [x] resolver 表驱动覆盖 `false -> default-index`、`true -> semantic-recall`。
- [x] Prompt 测试逐字覆盖两分支，并证明只相差 pointer 段。
- [x] Index 测试证明 semantic 分支不调用 `readTextFile`、不投影、不 seed read-state。
- [x] Recall 测试证明 default start/consume no-op；semantic 经过真实 selector prefetch 和完整 tool
      batch 后只注入一次 `relevant_memory`。
- [x] provider-body 测试冻结两种 Main body、Selector request 与 Recall MCS，并拒绝混合组合。
- [x] headless CLI scripted provider 同时识别两套分支合同；当前构建执行 default trajectory。
- [x] 不复制第二套 WDIO，不新增产品测试入口。

## 5. Phase 3：全链路验证与 scope 收口

- [x] Core retrieval/context/recall focused tests。
- [x] Adapter Memory/MCS final wire tests。
- [x] Headless CLI Memory trajectory E2E。
- [x] MEM08 fixture contract 与真实 Electron WDIO default replay。
- [x] `pnpm typecheck`、`pnpm lint`、`git diff --check`。
- [x] `rg` 审计原始 boolean 只定义一次，所有调用方只消费派生 branch。
- [x] 审计 staged、unstaged、untracked diff，无计划外配置、协议、UI、Dream trigger、retry、fallback、
      observer、repository 或持久任务。
- [x] 更新验证命令、结果和残余风险；保持改动未提交。

## 6. 明确非目标

本次不修改：

- app-global `memoryEnabled` 的 session-scoped 生命周期。
- `features.memory`、`memory.use`、root、权限或文件协议。
- Extraction snapshot/scheduler、Dream handler、Custom Agent Memory。
- Desktop/mobile/relay 协议与 UI。
- `/dream` 或任何 Memory 管理入口。
- Read 工具、secret/PII scanner、foreground observer。
- timeout、retry、keyword fallback、Repository、job DB 或持久 cursor。
- 其他请求形态下的动态 system prompt 差异。

## 7. 本轮验证证据

- Core：5 files / 71 tests passed。
- Adapter：2 files / 7 tests passed。
- Headless `default-index`：7 Main、0 Selector、5 Extraction、2 Custom Agent，请求与 index
  fixture 互斥断言通过。
- Headless 临时单点切换 `semantic-recall`：8 Main、2 Selector、5 Extraction、2 Custom Agent，
  包含已有事实 Recall 和 Extraction 事实跨 session Recall；验证后常量已恢复为 `false`。
- Electron WDIO：`conversation-session-memory.test.ts` 1 passing，覆盖当前 default active path、
  Extraction、Custom Agent 与 Settings disabled gate。
- 全仓 `pnpm typecheck` 通过；全仓 `pnpm lint` 通过（0 error，52 条既有 warning）；
  `git diff --check` 通过。
- scope 审计确认本轮没有新增配置、环境变量、Settings、协议、UI、Dream trigger、retry、fallback、
  observer、Repository 或持久状态；当前常量保持 `false`，所有改动保持未提交。
