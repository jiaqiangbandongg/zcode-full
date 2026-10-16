# M6 Model-Selection Parity — 输入框「选模型」逻辑补齐规划

> **状态：已实施，本文保留为 M6 迁移轨迹。** 当前入口是
> `packages/ui/src/v4/composer/V4ComposerToolbar.tsx`、`useDraftConfigControl.ts` 与
> V4 `commands/handlers/model-config.ts`；下文旧 `ChatInputToolbar` 路径只表示对账基线。

分界原则续 `m5-composer-parity.md`：**壳老芯新**——展示件复用旧 `ModelConfigSelect` / `ChatInputToolbar`
的纯组件；状态编排与写路径全部 v4（读投影 `snapshot.config`、写 v4 命令、无桥、新不调旧）。

参考基线：z-code-2（线上老版）`packages/ui/src/chat-input-toolbar/*`、`packages/ui/src/lib/*`、
`packages/ui/src/ChatInputToolbar.tsx`、`apps/zcode-cli/packages/*`。
现状载体：`packages/ui/src/v4/composer/V4ComposerToolbar.tsx`、`SessionPane.tsx`、
`apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/handlers/model-config.ts`。

> M5 composer 还原时「壳老芯新」是对的，但只对齐了「选择器长什么样 + 值从投影读」，
> **围绕选择器的选型逻辑（持久化 / 兜底 / entitlement 门控 / 连接方式 / 跨 provider 凭据解析）
> 整体漏迁**。本文档系统对账并给执行计划。`m5-composer-parity.md §六` 已登记的
> usage breakdown / cache-hit / 用量面板并入 Phase 4c，不重复排。

## 用户裁决（2026-07-07）

1. **范围 = 全量对齐**，含 Phase 1（CLI provider 凭据解析）+ Phase 4b（连接方式切换）。
   不做这层，coding-plan 列表「点了不换」、选任意别的 provider 的模型都是摆设。
2. **「记住上次选择」= 恢复老版全局语义**：ZCode-Agent 模型跨 workspace 全局记住，
   custom provider per-workspace；含 legacy 键迁移。
3. **实施隔离**：在独立 worktree `z-code-m6-model`（分支 `m6-model-selection`，
   基于 feature/v4-vertical-slice 52fb19e61）改+提交+测，主目录另有并发 session，回头 cherry-pick/merge。

## 一、缺口清单（能力 × 老版实现 × v4 现状）

### A. 记住上次选择（持久化）— 真缺口
| 能力 | 老版来源 | v4 现状 |
|---|---|---|
| last-model 持久化（全局键 `zcode-last-agent-model`，ZCode-Agent `__global__`、custom per-workspace） | `lib/zcodeModelPreference.ts:15,50,230,289` | ✗ 仅 workspace-default（per-workspace）`useDraftConfigControl.ts:221` |
| legacy 键迁移（workspace-scoped / path-only → global） | `zcodeModelPreference.ts:246-286` | ✗ |
| thought-level 持久化 + GLM-5.2 default-max | `zcodeModelPreference.ts:16,327,505-553,571` | ✗ |
| 启动作种子 + 对目录再校验 | `chat-input-toolbar/modelSelection.ts:609-660` | 部分：草稿回落 workspace-default `V4ComposerToolbar.tsx:146-150`，无全局种子/再校验 |

### B. 兜底 / 自动定位（fallback）— 真缺口
| 能力 | 老版来源 | v4 现状 |
|---|---|---|
| 当前模型不在可选组 → 退首个可用 / 清空 | `modelSelection.ts:678` + 状态机 `ChatInputToolbar.tsx:1937-2085` + `setTaskVisibleModelListFallback:1923` | ✗ 失效不自愈，显原始 id |
| 登录后自动选该家首模 | `modelSelection.ts:755`（`resolveLoginProviderFirstModel`）+ `:733` | ✗ |
| `<synthetic>` 占位 | `modelSelection.ts:350-414` | ✗ synthetic 直显 |
| entitlement 水合中延迟定位 | `modelSelection.ts:690-697,785` | ✗ |
| 空 config 降级 | — | 有：`SessionPane.tsx:792-801` + `modelMenuVisible` `V4ComposerToolbar.tsx:338` |

### C. Coding-plan 列表正确性 — 部分缺口
| 能力 | 老版来源 | v4 现状 |
|---|---|---|
| 建组 + coding-plan 分组/badge | `lib/modelSelectionGroups.ts:810,76,537` | ✅ `buildModelSelectGroups` `V4ComposerToolbar.tsx:215-227` |
| **entitlement 可见性门控**（未授权不显、start↔coding 互斥） | `modelSelection.ts:830-884` 应用于 `ChatInputToolbar.tsx:1123-1170` | ✗ 只过 `shouldIncludeModelProviderInSelection`；`entitlements` 只喂 start 余额 `V4ComposerToolbar.tsx:129-184` |
| **连接方式 Select**（Start/Individual/Team/API Key） | `ModelConfigSelect.tsx:365` + `onConnectionValueChange`；选项 `modelSelectionGroups.ts:371-498` | ✗ 未传 `onConnectionValueChange` `V4ComposerToolbar.tsx:375-391` |
| coding-plan 用量面板 | `chat-input-toolbar/CodingPlanContextUsage.tsx` + `ChatInputToolbar` ~150 行 | ✗（`m5-composer-parity §六` 二期） |
| context-usage breakdown + cache-hit | `chat-input-toolbar/contextUsage.tsx` | ✗ `SessionUsageState` 缺字段（`m5-composer-parity §六` 一期） |

### D. CLI 写路径 provider / 凭据解析（C 的地基）— 真缺口
| 能力 | 老版来源 | v4 现状 |
|---|---|---|
| 切模型解析 provider client + 凭据 + 连接方式换 runtime | `chat-input-toolbar/modelChangeActions.ts:462,647,982` + `useToolbarRecoveryModelChange.ts` | ✗ `handlers/model-config.ts:36-37`「凭据未做…只支持同 provider 直切」；仅 `app.setModel` `:64` |

### E. Polish
- `showManageModelsAction={false}`（`V4ComposerToolbar.tsx:379`）；`isItemLocked={()=>false}`（`:331`）；调试日志 `[v4-toolbar]/[v4-draft-config]/[v4-pane]`；压缩守卫维持死期（如需再议）。

## 二、分阶段执行计划

依赖：**4b 依赖 1**；2-CLI 侧受益于 1；3/4a/4c 基本独立。
推荐顺序：**4a + 4c → 1 → 4b → 2 → 3 → 5**。

- **Phase 1（D）**：CLI `switchModelConfig` 加 provider/凭据/连接解析（权威，不回端解析）；`command.ts` payload additive `connection?`；凭据缺失→结构化 failed ACK；`applyRequestedSessionConfig` 同步。L2 + e2e。
- **Phase 2（B）**：CLI resume 校验失效自愈 + 客户端 `useV4ModelAutoPosition` hook（移植 `modelSelection.ts` 纯函数：synthetic/登录首模/水合延迟/失效派发 switchModelConfig）。L1 + e2e。
- **Phase 3（A）**：移植 `zcodeModelPreference` 全局层（键作用域/迁移/thought/GLM-5.2 default-max）；`useDraftConfigControl` 作草稿种子；workspace-default 保留 per-workspace 层。L1 + e2e（切 workspace 后仍是上次全局选择）。
- **Phase 4（C）**：4a entitlement 门控（最轻，数据在手）；4b 连接方式 Select（依赖 1）；4c 用量面板 + breakdown/cache-hit（对齐 `m5-composer-parity §六`）。各带 L1/e2e。
- **Phase 5（E）**：manage-models、运行中锁、日志清理；压缩守卫留裁决。

## 三、验收口径
- 每 Phase 带 L1/L2 + e2e，先补 `docs/conversation-session-case-catalog.md` 与 `docs/testing/conversation-session-e2e-coverage-matrix.md` 再写 case。
- 纪律：`zcode-protocol-v4/` 无桥；新写不调旧协议；协议 additive + 同步 `10-protocol-spec.md`；能删的旧路径标死期并删。
- 跑 e2e 前：`node scripts/build-desktop-agent-cli.mjs` 重建 CLI bundle；`unset ELECTRON_RUN_AS_NODE`。

### 模型触发器身份一致性（2026-07-13）

- 模型选择身份是 `provider + model id`，不能只按模型名判断是否发生切换。
- 菜单项与关闭后的触发器必须共用 `modelSelectGroups + normalizedValue` 这一份事实源：触发器按完整编码值精确命中菜单项，并显示该项的 `name`。禁止再从 provider 配置的 `model.name` 二次取显示名，因为历史配置可能留下与实际 model id 不一致的旧别名。
- 收起后的触发器始终只显示菜单项模型名，provider 只用于菜单分组、精确选中和命令身份，不得出现在触发器文案中；即使同名模型横跨多个 provider，也不能显示“模型名 · provider”。手机 Web 远控继续复用现有紧凑截断规则。
- 当前编码值不在可选组时，继续沿用 Phase 2 的 synthetic / 失效模型占位逻辑，不把内部值直接暴露给用户。

状态链路：

```text
用户点击 provider A / glm-5.2
          |
          v
onValueChange(encoded(provider A, glm-5.2))
          |
          v
CLI switchModelConfig -> snapshot.config(provider A, glm-5.2)
          |
          v
rawModelValue = encoded(provider A, glm-5.2)
          |
          v
modelSelectGroups 精确命中同一菜单项
          |
          `--> 触发器始终只显示：glm-5.2
```

### 跨模型 thought 兼容与命令可观察性（2026-07-14）

- `switchModelConfig` 的 `thought` 在模型菜单切换场景里是源模型当前值，不代表用户同时为目标模型选择了同名思考档位。跨模型/跨 provider 时不得把它作为目标模型的强制档位；目标模型由 runtime 根据全局偏好和自身能力选择兼容档位，`ModelSelected` 必须发布 runtime 最终实际值。
- provider/model 未变化时，`thought` 才表示一次显式思考档位切换；不支持的值继续返回失败，不能静默伪装成功。
- `createSession.config` 可能携带上一个模型留下的 thought。应用目标模型后仅在目标 `listThoughtLevels()` 明确支持时覆盖，否则保留目标模型默认档位，不能让预热 session 因 `Unsupported reasoning effort` 留下“runtime 已切换、投影仍是旧模型”的半完成状态。
- ACK、事件投影和 runtime 必须同向：模型身份一旦切换成功，就要用实际 thought 发布 `ModelSelected`；禁止在模型已变更后因附带 thought 不兼容而整条命令失败。

状态链路：

```text
源 snapshot: GLM-5-Turbo / enabled
              |
              | 用户只选择 DeepSeek-V4-Flash
              v
switchModelConfig(provider=deepseek, model=deepseek-v4-flash, thought=enabled)
              |
              v
runtime.setModel(deepseek/deepseek-v4-flash)
              |
              +--> enabled 被视为源模型附带值，不强制写入目标模型
              |
              v
runtime 实际 thought（目标模型兼容值，例如 max）
              |
              v
ModelSelected(deepseek/deepseek-v4-flash, max) -> accepted ACK -> snapshot/UI

同模型只切 thought：
snapshot model identity 不变 -> setThoughtLevel(用户显式值) -> 成功发布 / 不支持则失败且模型不变
```

## 四、执行进度
- [x] **Phase 4a — entitlement 门控**（`5c14a3927`）：`filterModelProvidersByEntitlement` 纯函数 + V4ComposerToolbar 建组接入 + 7 单测。
- [x] **Phase 3 — 全局 last-model 持久化**：`seedDraftOptionsFromGlobalPreference`（草稿目录种子，对目录再校验）+ `useDraftConfigControl` 写全局/首发一致性种子 + `SessionPane` 会话中途切也写全局 + 4 单测。
- [~] **Phase 2 — 兜底/自动定位（slice1+2 完成）**：slice1 触发器显示（`<synthetic>`/不可用模型回落占位「选择模型」，`resolveModelSelectTriggerDisplay`）；slice2 会话态失效模型自愈切首个可用（`resolveV4ModelAutoFallback` 纯函数 8 单测 + 工具条 effect，entitlement 水合排除 + guard 防抖）。**slice3 登录后自动选首模 deferred**（v4 缺 login 事件信号，`resolveLoginProviderFirstModel` 现成，待 login 面 v4 化时接）。
- [ ] Phase 4c — usage breakdown/cache-hit + 用量面板
- [~] **Phase 1 — CLI provider/凭据解析（核心已完成，`c9c67b061`）**：1c 混合，CLI overlay host capability（setModelCatalogOverlay→setModel，无桥）使能跨 provider 切换；4 新 L2 + 无桥门禁绿。**收尾项**：1a app 侧 re-push/resend 边缘回落 + e2e（见 `m6-p1-runtime-model-resolution.md §7`）。
- [ ] Phase 4b — 连接方式切换（依赖 P1）
- [~] **Phase 5 — polish**：manage-models、运行中锁已完成；模型触发器 identity/显示同源修复已完成，其他 polish 待收尾。

### 遗留/待跟踪
- Phase 3 已覆盖：草稿选择/会话中途切→写全局；新草稿→种子回放（跨 workspace）。**e2e 待补**（切 workspace 后 ZCode-Agent 模型仍是上次全局选择），先补 case catalog + coverage matrix。
- Phase 4a 的 team-plan 豁免依赖 `useSettings` 的 `modelProviderFamilySelectedKeys`（存活配置面）；连接方式切换本身归 Phase 4b。
