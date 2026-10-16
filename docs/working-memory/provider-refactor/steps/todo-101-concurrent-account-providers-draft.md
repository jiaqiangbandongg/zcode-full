# Todo 101 Draft：多个具体 Account Provider 并存

> 状态：Draft / 延后实施；2026-09-09。
> 用户裁决：先按现有架构完成本次上线，本项只记录未来方向，不在本次实施。
> 本文不是当前运行契约，不自动覆盖现行 spec、迁移规则、Todo99 或 Todo100 的裁决。

## 一、已明确的未来产品方向

1. 个人套餐、Team A、Team B 可以同时连接和使用，不再通过一个全局当前连接互斥。
2. 设置页在个人/团队之间切换，只切换展示页面，不改变全局执行状态。
3. 每份显式 ModelSelection 必须指向具体个人/团队 Provider；删除根据当前连接自动对应另一个 Provider 的逻辑。
4. 旧 ModelSelection 的 Provider 迁移必须重新设计，不能沿用“统一迁到个人，再由运行时对应当前套餐”。
5. 模型选择器增加抽屉式界面，将多个 Account Provider 放在上方。抽屉具体形态待确认。
6. 仍然只能同时登录一个账号；多个个人/团队套餐并存不等于多个登录账号并存。闲时 Provider 由该登录账号决定，不增加个人/Team A/Team B 的闲时供额选择。

```text
唯一登录账号下，多个 Account Provider 并存
├─ 个人套餐
├─ Team A
├─ Team B
└─ Start Plan（具体并存/接入边界待细化）

会话甲   -> Team A / Model / Reasoning
会话乙   -> 个人 / Model / Reasoning
定时任务 -> Team B / Model / Reasoning

设置页查看哪个套餐，不影响上述执行身份
```

## 二、本次上线与未来改造的边界

- 本次继续使用现有单连接架构；不提前删除 current 门禁，不提前停止现行有效选择对应，也不提前更换 Provider ID。
- 不提前变更 Settings / Selection 持久化格式、账号鉴权归属、模板规则或选择器布局。
- Todo100 已确认的同步完整性、真实确认、派发参数丢失等问题，仍须按本次上线要求逐项裁决，不能因为未来会移除 current 就将现有 Bug 标记为无需处理。
- 现有暂停实验保持暂停；本文不授权恢复 Todo99、不授权推送或部署。
- 本文状态不能记为“已实现”“本次上线范围”或“现行设计已替换”。

### 对当前修复方向的指导

1. 临时同步修正确性即可，不为它建设难以移除的新平台。Worker 生命周期归口的具体方案仍按当前讨论单独裁决。
2. 保留公共 applied snapshot、完整性校验、原意图保护和精确 ModelFactory，这些能力未来仍然需要。
3. 当前如需修复个人/Team 的自动对应，复用已有公共规则，不增加更多业务特判；其未来删除边界要清楚。
4. 暂不把“根据全局连接自动换 Provider”固化进 Model.bind 或底层 Factory。未来仍需精确创建，不值得围绕将淘汰的语义扩大公共 API。
5. 不以未来架构为理由删掉当下正常功能，也不为未来预先引入双套账号身份/迁移路径。

## 三、代码调查已确认的结构限制

调查基线：`86bbe157c88e8e599694afb53c39f6dac125ac08`。以下是设计依据，不是本项已实现内容。

| 当前结构 | 未来必须调整的原因 | 代码入口 |
| --- | --- | --- |
| 每个域只有一个固定 Team Provider ID | Team A/B 共用 ID，无法在 Selection 中同时独立指定 | `packages/shared/src/model-provider-types.ts` |
| 每个 Family 保存一项 connection selection | 表达的是互斥当前连接，而非多个账号实例 | `packages/shared/src/provider-family-connection-selection.ts` |
| Settings 导航写入 connection selection | 浏览页面会改变执行侧事实 | `packages/ui/src/settings/ModelProviderSection.tsx` 的 `persistProviderFamilyModeForNavItem` |
| Account Resolver 通过 current 限制执行范围 | 多个具体 Provider 并存后不再需要普通账号 current 门禁 | `packages/provider/src/resolver.ts`、`packages/services/src/model-provider/accountProviderConnectionResolver.ts` |
| 请求鉴权读取当前兼容连接 | 即使 UI 选了 Team A，也不能在请求期改取 Team B 的凭据 | `accountProviderConnectionResolver.ts` 的 `resolveCurrentAccountAccess` |
| 旧 Coding Plan 统一映射 Individual | 正确性依赖后续自动对应；删除对应后必须重订迁移策略 | `packages/shared/src/legacy-model-provider-identity.ts` |
| Account 选择器按固定 Family/Plan 生成组标签 | 动态团队实例需要唯一 key、准确标签和同名模型来源区分 | `packages/ui/src/lib/modelSelectionGroups.ts`、`packages/ui/src/ModelConfigSelect.tsx` |

## 四、建议架构方向（尚未冻结实现）

### 4.1 具体 Provider 身份与实例化

```text
Built-in：套餐类型的公共定义/模型规则
                    |
Account：个人、Team A、Team B 的具体身份与权益
                    |
                    v
             具体 Provider 实例
                    |
Personal：具体实例的配置覆盖、模型启停和顺序
                    |
                    v
             完整 Registry / View
```

- 具体实例拥有稳定 Provider ID，不使用团队名称、列表序号、Token 等作为身份。
- ModelSelection 可以继续保留 providerId/modelId/options 的结构；团队身份由 Provider 对应的账号实例事实提供，不把凭据塞入 Selection。
- 组织、项目、产品等哪些字段参与稳定身份，需要核实服务端实体语义；请求需要某字段，不代表该字段必然适合做长期 ID。
- Built-in 与 Account 的职责从“固定一个 Team Provider + 当前团队”变成“公共类型定义 + 具体实例”。评估复用现有 Template 能力，不把账号实例伪装成普通用户自建 Provider。
- 是否把登录主体纳入实例身份、如何处理同域账号退出后换人登录，必须明确，不能让旧选择无声绑定到另一个人的套餐。

### 4.2 精确选择、精确鉴权

```text
Selection 指向具体 Team A Provider
                |
                v
同一完整快照内校验 Provider / Model / Reasoning
                |
                v
ModelFactory 精确创建
                |
                v
按 Team A 身份取得或刷新凭据
```

- 删除个人→Team、Team A→Team B 的运行时自动对应。
- 可以保留公共输入式 Selection View 与有效性结果，但不能更换输入 providerId；Provider/Model 不可用时保留原意图，执行明确失败或 UI 按既定规则暂时留空。
- 动态刷新 Token/Key 不等于动态改变请求归属。Team A 失效不能用 Team B 凭据继续执行。
- 隐式 Subagent 仍继承父 Active Model；显式选择使用具体 Provider；固定执行、重试和内部 override 保持既定边界。
- Account availability/entitled 仍有用途；普通账号 current 不再作为执行门禁。设置页当前浏览项仅属 UI 状态。

### 4.3 多入口 UI

- 个人、各 Team、Start 的显示状态、权益和模型分别展示；页面导航不修改执行状态。
- 选择器将 Account Provider 放在上方，展开 Provider 与选择模型是不同动作；仅展开不能修改草稿选择。
- 同名模型必须能够区分个人/Team A/Team B 来源；内部 ID 不直接当用户文案。
- Composer、Automation、Bot、Wiki、Subagent 复用候选与分组规则，各自保持草稿、提交和保存边界。
- 桌面和手机共享选择语义；抽屉形态、搜索、键盘导航、主题、双语与长团队名在正式设计时一起确定。

## 五、迁移专项：必须重新讨论

### 5.1 不再依赖运行时自动对应

| 原数据证据 | 建议处理方向 |
| --- | --- |
| 普通自定义/API Provider 明确身份 | 保留原身份，正常格式迁移 |
| 明确个人或完整团队身份 | 迁到对应具体 Provider，不要求它当前有权益/模型可执行 |
| 仅旧通用 Coding Plan ID，无具体归属 | 不能凭空恢复历史团队，必须裁决一次性归属策略 |
| 旧 Team Provider 下的个人模型覆盖/排序 | 必须裁决归给哪个实例，不能默认复制到全部团队 |

候选方案：优先使用记录自身/可验证旧关联信息；不足时，把升级前保存的旧连接作为一次性迁移默认。该默认不代表历史真实执行归属，尚未获用户确认。仍无法确定时如何保留原记录与提示用户，另行裁决。

### 5.2 本次先上线会改变未来兼容范围

- 以前“不兼容本分支未上线中间格式”的原则，不能用于忽略**本次正式发布后真实写入的数据**。
- 未来实施前，必须按实际发布版本确认迁移来源，包括届时正式保存的个人/固定 Team Provider ID 与旧连接信息。
- 如果旧通用选择已经迁成个人，且原归属证据不再存在，未来不能仅凭个人 ID 推断它原来属于哪个团队；需承认信息不足，明确用户确认或一次性映射策略。
- 本次不因此预先修改数据或增加迁移字段。正式实施前重新审计数据证据与兼容范围，不能照搬当前 Draft 假设。
- 迁移阶段识别旧字段，正式运行不持续回读旧连接来决定 Provider；网络/Registry 暂时不可用不构成删除持久选择的理由。

## 六、Off-Peak、同步与隔离边界

- 已裁决：唯一登录账号决定使用 BigModel 或 Z.ai 对应的既有闲时 Provider。普通个人/团队 Provider 可以并存，但不新增“为闲时任务选择个人/团队供额连接”的产品操作。
- 设置页浏览项、普通模型选择都不参与闲时 Provider 的选择；删除的是普通套餐的全局互斥选择，不是登录账号身份。
- 已取得的 Ticket 保持既定绑定；更换登录账号不能把已有 Ticket 自动改绑。资格、凭据和 Ticket 仍按闲时既有协议取得，未来实现时核对旧代码对普通 current connection 的依赖，不把它转化成新的用户选择项。
- 同步需要传完整账号实例事实；旧 current 字段将退出，但完整接收、正确应用、Worker 生命周期与失效恢复仍有价值。
- 保留目标 Host 权威、workspaceIdentity 隔离、手机 shared-host attachment，以及 desktop continuous / web replayable 分界。
- 本轮不扩展独立 CLI 的账号能力；多个登录账号同时在线明确不在本项范围。

```text
唯一登录账号
    ├─ 该账号的个人 / Team A / Team B -> 各自独立的普通 Provider
    `─ 账号所属体系 BigModel / Z.ai   -> 对应闲时 Provider -> Ticket
```

## 七、尚待裁决

1. 登录后自动发现/开放全部有资格套餐，还是用户逐个显式连接？查看页面不能隐含连接/创建 Key 等副作用。
2. 单账号约束已定；退出后换人登录时，原具体 Provider 身份和持久选择如何隔离、保留和恢复，仍需在身份设计中明确。
3. Team 实例的稳定身份粒度：组织、项目、产品分别承担什么角色？重命名、续费、重新登录如何保持选择稳定？
4. 旧通用选择的迁移默认、信息不足时的处理，以及旧 Personal Team 覆盖的归属。
5. “抽屉式”是选择器内展开 Provider，还是完整侧边/底部面板？关闭与取消是否只影响浏览状态？

闲时归属问题已裁决，不再列为待选方案：由唯一登录账号确定，保留既有 Ticket 绑定。

## 八、未来实施顺序与验收方向

实施前重新调查上线后的真实代码和数据，再补正式 spec 与测试；以下只是建议顺序：

1. 稳定实例身份、连接生命周期和配置实例化。
2. 按具体实例查询权益、取得凭据；删除请求期全局连接依赖。
3. 明确迁移来源及一次性迁移规则、个人覆盖归属。
4. Registry / Selection 删除 current 与跨 Provider 自动对应。
5. 设置页纯导航、公共选择器抽屉与准确来源标签。
6. 多入口派发、后台任务、Ticket、同步、归因和桌面/手机/SSH 验证。

关键验收：Team A/B 并行请求各自正确计费；查看另一页面不影响任何选择；A 失效不改投 B；同名模型可辨认；重启/重命名不丢实例；个人覆盖不串团队；未确定迁移不毁原数据；已固定执行和 Ticket 不被替换。

完成本 Draft 的记录不代表开始实施。用户重新启动本项并完成待裁决边界后，才更新正式运行契约。
