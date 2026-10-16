# Todo118：Provider 首次迁移保留用户启停状态

> 状态：2026-09-11 已实现首次导入修复，定向测试与局部 review 通过；账号不可禁用的联合验收随 Todo117，整批最终验收仍待执行。未修改真实用户配置。

> 最新裁决：内置账号 Provider 的旧禁用全部取消，不允许禁用；不再等待区分其禁用由用户还是系统产生。手动 Key Provider 保留启停能力，模板创建的实例不等于内置账号。现行账号写入／解析约束由 Todo117 承接，本项负责首次迁移。

## 已确认的问题

以 `origin/staging_backup` 为旧格式基线。旧配置保存 Provider 外层 `enabled`，读取器也能从外层或旧 `zcode.enabled` 正确读出它。当前 `importLegacyPersonalProviderConfig()` 创建新 Provider 规则时没有复制该字段，而公共 Resolver 使用 `rule.enabled ?? true`。

```text
旧配置 enabled=false
  → 读取器保留 false
  → 导入器遗漏 enabled
  → 新规则 enabled 缺失
  → Resolver 默认启用
```

已调用实际导入器及 Resolver 做无联网内存验证：自定义 Provider 的旧值分别为 `false`、`true`、缺失时，导入结果均缺失 enabled，解析结果均为 true。不是 UI 假显示，也不需要特殊模型或复杂操作才能触发。

相关入口：

- `packages/services/src/model-provider/legacyZCodeConfigProviderReader.ts`
- `packages/services/src/model-provider/legacyPersonalProviderConfigImporter.ts`
- `packages/provider/src/resolver.ts`
- `packages/services/test/legacyPersonalProviderConfigImporter.test.ts`
- `packages/services/test/legacyProviderUpgrade.test.ts`

## 修复范围和边界

1. 自定义 Provider：保留旧启停意图，将明确的 `enabled` 写到新 **Provider 规则外层**，与 `providerId` 同层，不写进 `config` 或模型规则。false、true 原样保留，缺失仍缺失；不修改 Resolver 的统一默认行为。
2. 不把 Provider 禁用转成逐个禁用模型，不清 Key、模型成员、历史 Selection，不影响已固定的运行中执行。不借机修改账号域、套餐或权益。
3. 旧内置账号身份：不导入 enabled=false，不再区分用户禁用或系统因登录、连接、权益失败生成的禁用。账号 Provider 按当前配置重建，仍遵守连接、权益、凭据及模型执行资格；不是强制可执行。
4. 旧 `builtin:bigmodel / builtin:zai` API 身份沿用 Todo35 只迁 Key、不抢救旧 enabled 的既定边界，不借本项扩大身份迁移。迁移后手动 Key 实例仍可由用户启停；其他预设模板创建的手动实例也不适用账号不可禁用规则。
5. 本项首先修正首次导入。已完成迁移的新手动 Key 配置不得从旧文件自动覆盖：新旧 enabled 不一致可能包含迁移后的主动修改。已有账号 enabled=false 由 Todo117 的新统一语义使其不再生效，不靠重跑迁移或旧文件回读。已迁移手动 Provider 的补救不在本项自动实施。
6. 原始旧配置保留，不覆盖、不双写；不新增运行时旧字段回读。思考档位迁移遗漏另由 Todo121 修复，不纳入本项。

## 验收与复审

- [ ] 先补有区分力的测试：旧自定义 Provider 为 false／true／缺失，读旧文件、导入、保存新格式、重读及 Resolver 全链路分别保持预期。
- [ ] 使用有效 Key 占位符及完整模型配置的离线 fixture，证明 false 不发布可执行模型；true 与缺省仍受公共配置完整性等条件约束，不因启用而放宽执行资格。
- [ ] 覆盖旧外层 enabled 与旧扩展字段的读取优先级，验证新字段位于规则外层、Schema 可接受；原始配置内容不变。
- [ ] 核对内置 API／账号分支：旧 API 只迁 Key；账号旧禁用不导入，含有／缺少 systemDisabledReason 均不阻塞。与 Todo117 联合验证账号不可禁用，手动 Key 和模型各自的启停不受影响。
- [ ] 保持首次导入边界：新配置存在时不重复导入，不覆盖升级后用户主动启停。
- [ ] 检查并更新旧迁移测试的预期；已有测试输入 enabled=false 却未断言启停，不得继续作为该行为通过的证据。
- [ ] 批量完成相关单测、typecheck、lint、架构检查及完整 review；记录运行验证和未测限制。当前仅文档阶段不执行产品回归。

完成声明必须区分：首次迁移保留手动 Provider 启停、内置账号取消禁用、已经迁移手动用户的补救不在范围内，不互相替代。内置身份不再有待用户裁决项。

## 本轮实现与复审

导入器仅在自定义分支写入明确的外层 enabled，缺失保持缺失；内置身份分支不变。旧文件→新文件→Resolver 的参数化用例先复现丢值，修复后三个测试文件 20 项通过；已覆盖外层与扩展字段优先级、新版重读、升级后主动反转启停不重复导入、旧文件字节不变与实际 Registry 发布。根 typecheck、lint（0 errors / 41 既有 warnings）、架构（0 violations）通过。

局部 review 未引入运行时旧字段回读、数据补救、Key/模型级启停改写或身份猜测。Todo117 联合批次已验证账号取消禁用且资格检查不放宽；首次迁移追加有/无合法 systemDisabledReason 和启用但缺 Key 不可执行断言通过。清单要求的代码与离线全链路已覆盖，整批最终交付复审待执行。完整批次记录见 [执行账本](./provider-stabilization-20260911-execution.md)。
