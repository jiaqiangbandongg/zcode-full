# Todo155：Start 连接依赖清理与模型切换套餐标识

> 状态：初版问题清单，已由 [Todo156](todo-156-start-plan-followup-final-decisions.md) 取代。保留 2026-09-16 的调查历史，不作为当前实施范围；常驻决策、团队治理延期和最终验证以 Todo156 为准。
> 来源：[Todo154](todo-154-start-plan-independent-provider.md) 交付后的 Air 反馈、连接依赖专项审查与模型切换提示截图。
> 审查基线：`f2b40bda8c`，分支 `start-plan-independent-provider`。下述路径、函数和复现条件是可持久追踪的证据，临时报告不作为唯一依据。

## 1. 目标与状态归属

Start 已是独立 Provider，不应继续要求全局“连接方式”选中 Start。按照所展示事实的 owner 选择状态来源，不把所有场景机械地改成读取输入框。

| 场景                                 | 正确来源                                              |
| ------------------------------------ | ----------------------------------------------------- |
| 输入框额度、提交时同模型套餐推荐     | 当前输入框／表单的有效 Provider 与模型                |
| 会话余额／错误提醒                   | 会话实际执行的 Provider、模型及错误事实               |
| 历史模型切换分隔提示                 | 记录中的 fromProvider/fromModel 与 toProvider/toModel |
| Start 可用性、设置页权益             | 当前登录账号及 Start 的账号权益、模型配置             |
| 设置页个人／团队连接、团队用量 scope | 全局付费连接及完整团队身份                            |

```text
登录账号 → Account Source → Start 权益 / Registry
                                  ↓
输入框有效 Provider + model → 对应额度展示 / 提交推荐
会话执行 Provider + model  → 会话余额 / 业务错误提醒
历史切换记录的前后身份     → 历史套餐名称展示

全局个人 / 团队选择 → 付费访问上下文与团队 scope
                   不作为 Start 可用或展示的门禁
```

不新增可变状态 owner；沿用原提交、缓存和恢复契约，保留桌面 continuous 与手机 replayable 的边界。

## 2. 问题与实施清单

### T155-01：输入框 Start 余额仍要求全局 Start 连接

- [ ] 修正 `packages/ui/src/v4/composer/V4ComposerToolbar.tsx` 的 `resolveV4ContextPlanConnection`：Start 按当前有效 Provider 确定，不要求 selection 存在或 kind 为 start-plan。
- [ ] 保留个人／团队额度对实际付费 scope 的合法依赖。
- [ ] 检查 `contextUsage.tsx` 的最终可见性与 Start 悬浮余额、刷新入口。

现状：两品牌输入框选中 Start 时，全局为个人、团队或未设置均返回 none；仅旧 start-plan 返回 Start。无上下文用量的新会话圆环消失；有用量的会话可出现圆环，但 Start 余额仍缺失。圆环还承载上下文用量，不能把圆环有无当成 Start 状态本身。

### T155-02：旧团队信息补全失败牵连 Start

- [ ] 修正 `packages/services/src/model-provider/accountProviderConnectionResolver.ts` 中 unresolvedFamilies 对整品牌的短路，Start 独立查询账号权益。
- [ ] 保留无法确认团队身份时对付费团队查询的限制，不猜组织／项目，不新增 migration。

链路：`settingService.prepareLegacyAccountConnections` → `node.ts` 的 readAccountProviderSettings → resolver。旧团队缺 organizationId 且补全失败时，当前把该品牌 Start 一并标 unknown；冷启动没有成功快照时可能导致 Start 不可选。该条件尚未在 Air 实机复现，不能作为此前 Air 套餐到期问题的解释。

### T155-03：会话余额与套餐身份查询缺 accountAccess

- [ ] 补齐 `packages/ui/src/v4/useV4SessionQuotaBanner.ts` 的 Start 查询访问描述，来源为该会话的执行 Provider。
- [ ] 检查并补齐 `packages/ui/src/hooks/usePlanIdentitySnapshot.ts` 中 Start／付费查询的访问描述，保持原套餐身份统计含义。
- [ ] 覆盖冷缓存、刷新和已有缓存，防止其他入口填充缓存掩盖缺参。

现状：useUsageEntitlement 原样转发参数，BigModelUsageQuotaProvider 不会仅凭 preferredProviderId 补 accountAccess；缺参的 Start 查询返回 not_configured、provider=null、quota=null。余额驱动的低余额／耗尽提示受影响；服务端错误驱动的提示有独立分支，不能宣称全部错误提示失效。

### T155-04：Start 无权益被展示为未连接／配置缺失

- [ ] 联动修正 `providerFamilyConnectionVisibility.ts`、`Detail.tsx`、`StatusCards.tsx` 的状态投影。
- [ ] 区分未登录、明确无权益／到期、待生效、查询失败和真正配置缺失；不再提示连接／断开 Start。
- [ ] 领取、购买与模型管理入口依据真实条件展示，不借 disconnected 控制入口可见性。

现状：Start 被排除在明确无套餐分支外，回退 disconnected；详情仅在 available/purchased 时走专属分支，其他情况下只因 settings view 存在便展示 accountProviderConfigMissing，未判断配置是否真的缺失。修正文案时必须同时核对领取卡门禁，避免入口消失。

### T155-05：团队连接下拉误读个人 Provider 的 current

- [ ] 检查团队导航项的三个构造分支，避免展开个人模板后仅替换 presetId、仍继承个人 provider。
- [ ] `ProviderFamilyModeHeader.tsx` 按实际团队 Provider 与团队身份判定是否选中；确需空选择时正确提供 placeholder。

现状：个人 current=false、实际团队 current=true 时，下拉可能误置 value 为空；SelectValue 没有 placeholder，呈现只有箭头的空框。此控件负责全局付费连接，不能改成跟随输入框的 Start 选择。

### T155-06：模型切换提示标明套餐类型

- [ ] 用户已确认：截图中的会话模型切换提示使用 `GLM-5.3(个人套餐)`、`GLM-5.3(体验套餐)`、`GLM-5.3(团队套餐)`；其他模型沿用相同格式。
- [ ] 前后两侧分别按记录中的 Provider ID 标注，同模型跨套餐仍可区分；BigModel 与 Z.ai 均覆盖。
- [ ] 不依赖当前全局连接、输入框草稿或目录可用性，不改写历史记录；普通自定义供应商保留原显示规则。
- [ ] 支持国际化、桌面／手机与深浅主题，长名称允许正常换行。
- [ ] 统一实施时检查相邻的首次使用提示和切换 toast 是否共用规则；暂停前草稿已包含这两处，作为实现范围候选评审。未要求把全部模型菜单、输入框标签或 Subagent 标签一并改名。

示例：`模型已切换 GLM-5.3(团队套餐) → GLM-5.3(体验套餐)`。

### T155-07：清理废弃流程，保留兼容读取

- [ ] 复核 `manualClaimPlanModelGuideStore` 与 Toolbar 旧领取引导：目前未发现生产请求方，但 consumer 仍要求 start-plan 并自动选模型；按退役流程清理，不能恢复领取后自动切模。
- [ ] 复核 `filterStartPlanItemsByEntitlement` 等旧 Start 导航过滤：生产调用前已排除 Start，区分不可达分支和有效兼容路径。
- [ ] 保留旧 kind:start-plan 的读取能力；不因清理全量改写会话、任务、自动化或 Subagent 数据。
- [ ] 对齐正式 spec、feature graph 中仍描述 Start 为连接选项、失效自动回落个人连接的旧内容；新规范以 Todo154 的独立 Provider 裁决为准。

## 3. 保持不变的边界

- 不启动 Todo101 的个人／多个团队全面并存，不合并两品牌 Provider ID。
- Start 请求继续使用当前登录账号的 JWT；无权益不偷偷消耗付费额度。
- 模型菜单、精确 Start 解析、请求鉴权、提交套餐推荐的已独立主链路保持，修复后回归。
- 不新增复杂账号竞态屏障、自动重发、第二份额度／连接状态或额外数据迁移。
- 任务触发、后台执行、立即运行和 Bot 不新增提交推荐。
- 同模型切套餐保留思考选项兼容校验；套餐类型只是显示，不改变模型选项。

## 4. 验收矩阵

| 编号  | 场景与预期                                                                                           |
| ----- | ---------------------------------------------------------------------------------------------------- |
| SC-01 | 两品牌 × 全局个人／团队／无选择／历史 Start：输入框选 Start 均能按其权益展示额度                     |
| SC-02 | 新会话零上下文与已有用量会话：圆环／悬浮层正确；切回付费后额度跟随实际 Provider                      |
| SC-03 | 旧团队组织补全失败：团队保持受限，已登录且有权益的 Start 独立可用；不新增迁移                        |
| SC-04 | Start 低余额、耗尽、查询失败、冷缓存及刷新：访问参数正确；原错误提示不回归                           |
| SC-05 | Start 未登录、无套餐／到期、pending、unknown、真正配置缺失分别展示；领取入口与模型管理无误导连接文案 |
| SC-06 | 团队 current=true、个人 current=false：下拉显示真实团队；旧 Start 用户仍能主动选唯一付费套餐         |
| SC-07 | 两品牌三类套餐，模型同名／不同名切换：两侧后缀准确；改当前连接、目录缺失或历史重放不改错套餐类型     |
| SC-08 | 普通自定义 Provider 保留原标签；中英文、桌面／手机窄屏、深浅主题无截断或溢出                         |
| SC-09 | 领取／浏览 Start 不修改模型或全局付费连接；历史设置仍可读，Start 不可用无付费 fallback               |

实施前先补真实预期的失败测试，再修实现。必要检查包括根 typecheck、lint、architecture:check --changed、受影响测试；交互 E2E 按用户要求通过 Pro admin SSH 执行。桌面窄屏不能冒充完整手机 shared-host E2E，未覆盖项明确记录；结束后全面 review。

## 5. 当前证据与暂停现场

- 专项审查现有 5 文件 118 条测试通过，但圆环测试仍要求全局 Start，旧团队补全测试仍断言 Start 为 unknown；这些通过不能证明独立语义正确。
- 对基线源码函数执行八组输入验证，两品牌均只有旧 start-plan 连接返回 Start 额度上下文；缺 accountAccess 的服务方法探针返回 not_configured 空快照。
- 暂停前仅 T155-06 已有未提交草稿：`modelTriggerDisplay.ts`、`ConversationRowView.tsx`、`SessionPane.tsx`、`v4ConversationRowViewTimelineMarker.test.ts`，以及正式 Start spec 的一段补充。保留工作区，不视为已完成交付。
- 该标签草稿先验证 7 项预期失败，修改后相关 2 文件 28 项通过；完整 typecheck、lint、视觉／端上验证及最终 review 尚未完成，没有 commit 或 push。
- T155-01～05、07 尚未实施。按用户最新要求，本轮只记录新 TODO 与入口链接，不继续修改产品代码。
