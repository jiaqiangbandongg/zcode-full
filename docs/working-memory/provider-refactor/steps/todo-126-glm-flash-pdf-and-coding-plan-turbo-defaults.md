# Todo 126：GLM 视觉标展示、Flash PDF 与 Coding Plan API Turbo 默认配置

> 状态：2026-09-11 按整批 Goal 授权实施，局部验证/review 通过；整批最终验收待执行，未发布线上配置。
>
> 日期：2026-09-11

## 2026-09-12 补充：普通 API 的 Turbo 默认禁用

用户要求 Z.AI API / BigModel API 的 Turbo 默认禁用。当前 `GLM-5-Turbo` 已为 false，补齐 `zai-standard-api`、`bigmodel-standard-api` 的 `GLM-5V-Turbo` 精确模板规则为 false，并递增 Built-in revision。仅改变默认启停，不删除模型、不改变能力或个人覆盖；不改 Coding Plan、Account 或第三方。复用现有规则解析，无 UI、协议和迁移改动，不自动发布在线配置。

验证：用真实 Built-in Source 检查两模板的两个 Turbo 均关闭、5.3/Flash 仍开启、个人显式开启仍优先，以及无模板第三方默认不变。

实施结果：revision 22→23，仅修改两处 `GLM-5V-Turbo.enabled`。新增用例先复现两处默认 true，修复后配置/完整性/Release 共 34 项通过；typecheck 通过、lint 0 errors / 42 既有 warnings、架构 0 violations。未改 UI/执行代码，无额外交互 E2E；未推送或发布在线配置。

## 1. 背景与最终裁决

用户检查模型设置时提出 Flash PDF、GLM 视觉标与套餐 Turbo 默认值问题。已通过当前内置配置的真实 Node Source／规则解析复现，而非仅阅读 JSON：

- GLM-5.3-Flash 图片、视频已在通用模型规则中开启，但 PDF 只在 Anthropic Messages 的模型＋API 规则中开启，Chat Completions 与 Responses 下为 false。
- `zai-api`、`bigmodel-api` 两个 Coding Plan API 模板没有 GLM-5-Turbo 默认关闭规则。已有实例保留或手动添加该模型时，继承通用 `enabled: true`。
- GLM-4.7 通用规则关闭视觉，官方套餐站点的全模型视觉规则再将其开启。**用户确认这个行为没问题，不改。**
- GLM-5.3 通用规则关闭视觉，官方套餐端点开启。用户最新确认：Coding Plan GLM-5.3 的图片输入能力来自服务端桥接，不代表模型原生视觉；这里 GLM-5.3 与 Flash 的区别是目前只有 Flash 有原生视觉。因此**允许前端硬编码展示例外，在模型设置页和模型选择菜单隐藏 Coding Plan GLM-5.3 的视觉标，底层能力配置保持不变**。此裁决替代此前“不硬编码视觉标”的约束。

本 Todo 包含下面三项已确认修改，不能顺手改变其他模型能力、默认值或 UI。

## 2. GLM-5.3-Flash：所有接入默认开启 PDF

修改 `config/provider/zcode-builtin.json`：

1. 在现有 GLM-5.3-Flash 通用 `modelRules` 成员的 `config.properties.inputFormat` 中增加 `supportsPdf: true`，与已有图片、视频能力并列。
2. 删除现有 `modelApiRules` 中仅负责为 GLM-5.3-Flash 的 `anthropic-messages` 开启 PDF 的专用规则，不保留重复声明。
3. 沿用现有 Flash 模型匹配表达式及大小写／前后缀规则，不重新设计模型别名匹配。

修改后的含义：

```text
GLM-5.3-Flash 通用模型规则
  supportsImage: true
  supportsVideo: true
  supportsPdf: true
          |
  官方及第三方接入、三种现有 API 格式共用
```

- 用户明确要求包含第三方；不新增端点白名单，不局限某个模板。
- 覆盖 Anthropic Messages、OpenAI Chat Completions、OpenAI Responses 三种现有 API 格式。
- 不扩大到普通 GLM-5.3、GLM-4.7 或其他型号；不修改图片、视频及其他能力。
- 个人显式配置仍按现有覆盖规则优先，不能清除用户手动关闭 PDF 的设置或强制重置手动配置。
- 本次调整推荐能力声明，不授权改造 PDF 附件编码、读取限制或 Adapter。

## 3. Coding Plan API：GLM-5-Turbo 默认关闭

在同一文件的 `templateModelRules` 中，为两个模板各增加一条精确规则：

```typescript
{
  templateId: "zai-api",
  modelId: "GLM-5-Turbo",
  config: { enabled: false },
}
{
  templateId: "bigmodel-api",
  modelId: "GLM-5-Turbo",
  config: { enabled: false },
}
```

- 对应 Z.AI Coding Plan API、BigModel Coding Plan API 两个手动 Key 模板。
- 只改变默认值，不从模型名单删除或向名单新增模型，不修改模型 ID，不禁止用户手动开启。
- 个人显式启用或禁用仍按现有优先级生效；不迁移、不删除个人覆盖。
- 不改变账号登录的个人、团队、Start、闲时 Provider；不改变普通 API 模板或第三方接入的默认值。
- 不把模板默认关闭扩大为通用 Turbo 关闭规则，也不改 Account 精确规则。

## 4. Coding Plan GLM-5.3：隐藏视觉标

> 2026-09-12 补充裁决：[Todo137](todo-137-start-plan-glm53-vision-badge.md) 将体验套餐 Start Plan 纳入相同展示范围，下文保留原实施范围。

- 产品背景：服务端桥接允许 GLM-5.3 处理图片，但模型不是原生视觉；本次仅纠正徽标传达的含义，不撤销已有图片使用能力。
- 展示范围：模型设置页的模型列表，以及模型选择菜单中对应模型的视觉标。检查共用选择器的入口，不能只修设置页或只修主聊天框；桌面与手机 Web 展示保持一致。
- Provider 范围：Z.ai／BigModel 的个人、团队 Coding Plan 账号连接，以及手动 Coding Plan API Key 供应商。
- 只匹配上述范围内的 GLM-5.3；GLM-5.3-Flash 保留视觉标，其他供应商和模型不受影响。
- 按产品要求做前端展示特例，两个页面复用同一展示判断，不改通用能力事实；不要把 `supportsImage` 改为 false，也不要为了隐藏标识过滤整个模型。
- 图片上传、输入格式配置、附件支持、服务端桥接及实际模型请求全部保持原样。不新增能力 Schema、协议字段或数据迁移，不借此重构原生能力与桥接能力体系。

## 5. 发布与实施边界

```text
内置模型 / API / 站点 / 模板规则
                 |
           现有个人覆盖规则
                 |
          同一 Resolver 解析
                 |
         现有 UI 和执行链读取
```

- 完成第 2、3 节的内置配置修改后递增 builtin `revision`，沿用现有发布与刷新机制；实施时核对最新 revision，不写死本次排查时的版本号。第 4 节纯前端展示修改本身不需要递增 builtin revision。
- 不改 `schemaVersion`、Schema、协议、文件布局、数据表或迁移流程。
- 不修改 GLM-4.7 视觉及官方套餐的全模型视觉站点规则；GLM-5.3 仅允许第 4 节定义的视觉标展示特例，不改其实际能力。
- 不实施 [Todo125](./todo-125-model-settings-help-copy.md) 的问号和文案，不改模型设置布局。
- 不自动发布线上配置或推送代码；本次授权仅记录待办。

## 6. 实施与验收

授权实施后，遵循仓库测试先行与架构门禁要求。优先复用 `packages/provider-node/test/` 下已有 builtin 完整性、别名、模板及个人覆盖测试。

- [ ] 先建立失败用例：Flash 非 Anthropic 格式的 PDF 默认应为 true；两个套餐 API 模板的 Turbo 默认应为 false。
- [ ] 实际加载 builtin 并解析：官方／第三方、三种 API 格式、现有大小写与前后缀 Flash 别名均得到 PDF=true；普通 GLM-5.3、GLM-4.7 不被扩大。
- [ ] 验证个人显式 PDF=false 仍优先；手动配置模式不被推荐更新重置。
- [ ] 两个 Coding Plan API 模板 Turbo 默认 false，个人显式开启后仍可启用；其他模型、普通 API、第三方及 Account 个人／团队／Start／闲时默认行为不变。
- [ ] GLM-4.7 原有站点视觉结果、GLM-5.3 原有实际能力配置保持不变。
- [ ] 先补展示用例：个人／团队账号及手动 Coding Plan API Key 的 GLM-5.3，在设置页和模型选择菜单均不显示视觉标；同入口的 Flash 仍显示，其他 Provider／模型不被误伤。
- [ ] 验证图片输入和能力编辑仍按原配置工作，未因隐藏标识改变实际能力；补两个展示入口的浏览器验证，兼顾桌面／手机布局、主题及国际化，不把单个组件通过写成全端验收通过。
- [ ] 更新受到最终配置影响的旧测试期望及 revision 断言，完成相关回归、`pnpm typecheck`、`pnpm lint`、架构检查；按仓库要求维护相关 E2E。按三项的风险批量验证，不为每个小改重复整套回归。
- [ ] 如实记录执行结果及未验证范围。规则解析通过不等于真实模型端点已接受 PDF，也不等于已在所有 UI 和平台完成验证。

## 7. 本次落盘结果

三项已实施：builtin revision 20→21，Flash 通用 PDF 声明替代 Messages 重复声明；两个手动套餐模板新增精确 Turbo 默认 false；UI 共享 shouldShowModelVisionBadge，设置卡片和所有 buildRegistryModelSelectGroups 消费入口均接入。

### 实施证据与复审

- 测试先红：非 Messages Flash PDF、套餐模板 Turbo 和三类套餐视觉标共 5 个失败；修复后 6 文件 96 项单测通过。真实 Node Built-in Source/有序规则覆盖三格式、官方/第三方、前后缀/大小写；正常个人覆盖与 manual-provider-model 都保持 PDF=false。普通 API Turbo 本来已默认 false，已纠正测试初稿的错误假设，没有把它改成 true。
- 两个浏览器用例通过：390 中文浅色/1200 英文深色，每条均检查个人/团队账号/手动套餐 Key，设置页和真实 ModelConfigSelect 菜单同时隐藏 GLM-5.3 视觉、保留 Flash。底层 supportsImage 仍为 true；上传/编码/请求代码没有修改。截图 `/tmp/zcode-provider-settings-batch/vision-*.png`。
- 根 typecheck、lint（0 errors / 41 warnings）、架构（0 violations）通过。与旧规则对照 review：GLM-4.7/GLM-5.3 能力及 Account 精确规则、名单均未改；模型选择项的 supportsVisionInput 仅供徽标消费，不参与附件执行校验。
- 浏览器验证为隔离共享组件，不代表真实手机 Host/Electron 整链路；未请求真实 PDF 服务，未发布线上配置。中文字体限制沿用本批记录，整体终审仍需执行。
