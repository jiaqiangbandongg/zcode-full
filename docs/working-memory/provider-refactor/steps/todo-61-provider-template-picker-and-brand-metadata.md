# Todo 61：Provider Template 选择页与品牌元数据收口

> 状态：已完成
>
> 日期：2026-09-02
>
> 背景：产品分支 `feat/provider-ux-refactor` 基于较早的 Provider 实现新增了供应商目录、Logo、侧栏样式等改动。本 Todo 不合并该分支，而是在当前 Provider Template、Provider Config Overlay 和 Registry 架构上重新实现已确认的产品意图。

## 1. 目标

在不恢复旧 Model Catalog、不新增第二套 Provider 候选源的前提下，完成以下设置页体验：

- 顶部提供统一的“添加供应商”入口；
- 入口在右侧详情区域打开 Provider Template 选择页；
- Template 选择页直接消费目标 Host 的 `ProviderSettingsView.providerTemplates`；
- 支持从 Template 创建 Personal Provider，也支持创建无 Template 的纯自定义 Provider；
- Template 名称支持中英文；
- 创建出的 Personal Provider 获得稳定、唯一、可编辑的 `label`；
- Provider Logo 由 Effective Provider Config 决定，不由 Renderer 按 Provider ID 维护第二份产品名单；
- 保持现有 Provider 设置页布局、滚动、拖动、Account Provider 和删除回落行为。

### Impact Brief

- Primary owner：Provider Config/Template 领域与目标 Host 的 Settings Facade。
- Primary UI：模型设置页的 Provider 导航、详情标题与新增 `ProviderTemplatePicker`。
- Downstream：Bundled/Remote Built-in Release、Active/LKG、Personal 创建、Desktop/Web/手机设置页。
- 不变量：Registry 身份、Account 页面、Model Rule 优先级、拖动/删除回落和模型执行语义不变。
- 主要风险：Release 壳版本未原子切换、Renderer 复制品牌事实、名称去重绕过 Host 原子更新、未知远端 Logo key 导致配置拒绝。

## 2. 术语与边界

### 2.1 不恢复 Catalog

本功能不使用 `Catalog` 作为领域名。旧 Model Catalog 曾经承担模型能力和运行时事实，已经退出 Provider 主链路；重新使用同名概念容易造成错误联想。

命名统一为：

```text
用户界面：添加供应商
代码组件：ProviderTemplatePicker
页面状态：template-picker
数据来源：ProviderSettingsView.providerTemplates
```

禁止新增：

- `ProviderCatalog` / `CatalogProvider` 领域类型；
- Catalog Service、Catalog Source 或 Catalog Repository；
- Renderer 内按 Provider ID 维护的候选列表或排序表；
- 从旧 Model Catalog、Preset 或远端产品配置补充 Template 事实。

唯一链路为：

```text
ProviderSettingsView.providerTemplates
                |
                v
       ProviderTemplatePicker
                |
        选择 templateId
                |
                v
 createPersonalProvider({ templateId, label })
                |
                v
       Personal Provider Config
```

### 2.2 领域壳原则

当一个领域对象除了 Config Overlay 之外还拥有自身元数据时，使用领域壳承载元数据和 Overlay；领域对象不直接等同于 Overlay，也不把领域元数据污染进通用 Overlay。

本轮只把该原则用于 `ProviderTemplate`。普通 Built-in Provider 没有新增独立元数据，不为了形式统一机械包装；Model Config Rule 的集中结构和优先级不变。

```ts
interface ProviderTemplate {
  readonly nameMap: ProviderTemplateNameMap;
  readonly config: ProviderConfig;
}
```

当前：

```text
ProviderTemplateMap
└─ templateId -> ProviderConfig
```

目标：

```text
ProviderTemplateMap
└─ templateId -> ProviderTemplate
                 ├─ nameMap
                 └─ config: ProviderConfig Overlay
```

以下结构不迁入 Template 壳：

```text
modelConfigRules
├─ matchRules
├─ templateModelRules
└─ providerModelRules
```

原因是它们共同表达清晰的规则优先级。把 Template/Provider 精确 Rule 搬进各自领域壳，会隐藏其前面仍有 `matchRules` Overlay 的事实；这不是本轮预期改动。

`providerTemplates` 的物理值结构发生了破坏性变化，因此 Bundled Release、Remote Release codec、Active/LKG cache 和测试 fixture 必须原子切换到同一个新 Schema Version。当前旧结构尚未正式发布，不提供 dual-read、旧壳 importer 或运行时 shape 猜测；旧客户端与新发布内容通过既有 app-version/Schema-Version 边界隔离。

## 3. Template 多语言名称

Template 壳新增 `nameMap`。键使用当前应用 Locale 的 BCP 47 标识：

```ts
type ProviderTemplateNameMap = Readonly<{
  readonly "zh-CN"?: string;
  readonly "en-US"?: string;
}>;
```

Built-in 发布内容应同时提供当前支持的中英文名称。当前 Release Schema 只接受 `zh-CN`、`en-US`；以后增加 Locale 时必须同步提升 Schema/Release Version，不能由旧客户端猜测新键。

名称解析顺序：

```text
nameMap[当前 locale]
        |
        +-- 存在且非空 --> 使用
        |
        v
nameMap["en-US"]
        |
        +-- 存在且非空 --> 使用
        |
        v
templateId
```

`nameMap` 只属于 Template，不加入 `ProviderConfig`，也不新增 `label_map`。Template 选择页直接使用它；Renderer 不维护 Provider ID 到 i18n message 的映射。

## 4. 创建与名称去重

Template 名称是创建时的名称种子，不是创建后 Provider 的动态名称。

```text
当前界面 Locale
        |
        v
从 Template.nameMap 解析名称种子
        |
        v
createPersonalProvider({ templateId, label: seed })
        |
        v
Config Service 在 Personal Config 更新锁内重新检查名称
        |
        v
生成唯一 label 并写入 Personal Provider Overlay
```

约束：

- UI 传入的 `label` 只是名称种子，不能绕过服务端去重；
- 去重必须与 Personal Provider 创建在同一次原子更新中完成；
- `initialConfig` 不允许携带 `label`，避免通用 Overlay 绕过去重入口；
- 名称冲突时延续 `Name`、`Name 2`、`Name 3` 的现有语义；
- 创建后 `label` 是稳定的 Personal 配置，切换界面语言不自动重命名；
- 用户后续改名继续写入同一个 Personal `label`；
- Template 配置更新不覆盖已创建 Provider 的 `label`。

纯自定义 Provider 继续使用本地化的“新供应商”名称种子，并经过同一原子去重入口。

## 5. Template 选择页交互

### 5.1 入口与页面

- 在设置页说明区域顶部、刷新按钮附近增加“添加供应商”按钮；
- 点击后左侧 Provider 导航保持不变，右侧详情区域切换为 `ProviderTemplatePicker`；
- 页面提供返回按钮；返回后恢复进入前的 Provider 详情；
- 创建成功后立即进入新建 Provider 的详情；
- 不新增窄屏上下分栏，继续使用当前左右分栏；
- 继续使用当前左右区域独立滚动，不重写设置页高度和 overflow 层级；
- 本轮不提供 Template 搜索。

### 5.2 Template 卡片

- 使用当前 Built-in Provider Template 的发布顺序；
- 不在 UI 维护 Provider ID 排序表；
- 页面首项或明确区域提供“自定义供应商”入口；
- 卡片整块可点击，并在右侧显示统一的进入箭头；
- 卡片严格使用 64px 固定高度；
- 名称保持单行，超出可用宽度时省略；
- 被省略时通过悬浮提示展示完整名称；
- 不使用 `overflow-wrap: anywhere` 拆散正常单词；
- Logo 使用统一尺寸与留白，名称占用剩余宽度；
- Desktop、Web 和手机布局均需验证长中英文名称；完整名称通过悬浮提示读取。

## 6. 设置页其他已确认改动

- Provider 侧栏仅调整 Logo 所需尺寸，不整体搬运产品分支的行高、选中态和状态样式；
- 状态点读取 Provider `executable`：可执行为绿色，不可执行为灰色；
- 不恢复 Provider 顶层 `enabled` 或 Provider Switch；
- 不显示“已启用”状态文案；
- “添加模型”移动到“模型列表”标题右侧；
- 删除 Provider 后继续使用当前导航 fallback，不实现相邻 Provider 选择；
- Provider 删除失败时保持当前选择；
- Template 选择页中的品牌名称由 Template `nameMap` 发布；`Z.AI` 中 `AI` 必须大写；
- 已创建 Provider 与 Account Provider 的名称继续读取各自 Effective Provider Config 的 `label`，不能反向读取 Template `nameMap`；
- 除已明确本地化的名称外，英文界面使用官方英文品牌名；不在 Renderer 按 ID 翻译品牌。

## 7. Logo 配置与打包资源

Logo 保留在 `ProviderConfig`，不在 Provider Template 壳中重复定义。`ProviderConfig` 已经承载 `label`、`visibility` 等 Provider 展示事实；Logo 同样是最终 Provider 的展示事实。Template 通过内部 `config` 提供默认 Logo，Account/Built-in Provider 直接通过自己的 Provider Config 提供 Logo，Personal Overlay 可以继承它。所有设置页最终只读取 Effective Provider Config，不按 Provider ID 推断 Logo。

### 7.1 当前实现事实

- `ProviderConfig.logoUrl` 当前只在 Schema、Overlay、Resolver 和旧配置迁移中流转；设置页没有消费该字段；
- 现有账号界面的 Z.AI / BigModel 图标由 OAuth 品牌图标 helper 提供；
- 普通 Personal Provider 和由 Template 创建的 Provider 当前统一显示通用 Package 图标；
- 产品分支新增了多份 80×80 PNG，并在 Renderer 中维护 `Provider ID -> Logo import` 映射；
- 该映射同时列举 Template Provider、Account Provider 和按量 API Provider，复制了 Provider 身份与品牌归属事实，不能原样采用；
- 产品分支的素材清单中，Moonshot、MiniMax、Xiaomi、OpenAI、Anthropic、xAI、DeepSeek 有可追溯来源；Z.AI 标记为用户提供；Alibaba 素材来自第三方 GitHub 仓库，不能据此认定为官方来源；
- 产品分支新增 PNG 统一为不透明方形画布，深浅主题、视觉留白和不同品牌图形尺寸尚未统一验证。

因此，本轮实施删除 Renderer 的 Provider ID Logo 映射，并把未被消费、名称又绑定 URL 载体的 `ProviderConfig.logoUrl` 直接替换为结构化 `ProviderConfig.logo`。当前结构尚未正式发布，不新增 `logoUrl -> logo` 兼容读取或 URL 转换；旧 Personal importer 也不迁移 `logoUrl`。Provider 与品牌资源的关联只在 Provider Config 中声明一次。

### 7.2 配置与资源结构

本轮结构固定为：

```ts
type ProviderLogoRef = Readonly<{
  readonly type: "builtin";
  readonly key: string;
}>;

interface ProviderConfigInput {
  readonly logo?: ProviderLogoRef | null;
}
```

虽然类型采用可扩展的辨别联合结构，本轮 Schema 只接受 `type: "builtin"`。不实现 URL、上传文件或 Data URL 类型。

`key` 是开放字符串，不在 Provider Schema 中枚举，也不参加 Provider 完整性或可执行性校验。UI 的通用资源解析器负责把 `key` 解析成 Desktop/Web 均可使用的打包资源；解析器不保存 Provider 排序、名称、Template 成员或 Account 产品逻辑。

```text
Effective Provider Config.logo
                |
                v
       Built-in Logo Resolver
                |
                +-- 已知 key --> 根据主题选择打包资源
                |
                `-- 未知/缺失 --> 通用 Package 图标
```

Official Config 可以远程发布客户端尚不认识的新 `key`。这种情况必须正常解析、保存并进入 Registry；旧客户端只回退通用图标，不能报错，也不能让 Provider 变成不可执行。客户端以后打包相同 key 的素材后自然显示 Logo。

这里的前向容错只针对未知 `key`，不针对未知 `type`。当前客户端只支持 `type="builtin"`；未来增加 URL、上传文件或其他类型时，需要随 Release Schema/客户端兼容策略正式升级，不能要求旧客户端猜测新资源协议。

由 Template 创建的 Personal Provider 继续通过 `templateId` 继承 Template `config.logo`，不把 Logo 复制进 Personal Overlay。因此远端 Template 在后续 revision 更新 Logo 时，没有显式 Logo 覆盖的既有实例会自然取得新素材引用；已有 Personal `label` 不受影响。Account Provider、Family 按量 API Provider 和其他 Built-in Provider 在各自的 Provider Config 中声明同一个 Logo key；允许多个 Provider 复用相同 key。

`logo` 是共同 Provider Config Overlay 的展示配置项：Personal Schema 可以显式覆盖已知 Built-in key，也可以用 `null` 清除并回退通用图标，但本轮 UI 不提供这一编辑入口。纯自定义 Provider 创建时不写 `logo`，默认使用通用 Package 图标。

Settings View、跨进程协议和表单 View Model 只原样投影 Effective Provider Config 中的同一 `logo` 结构；不增加 `resolvedLogoUrl`、`providerBrand` 或 Provider ID 映射。资源 URL 只在最终 UI 资源解析器中由 `logo.key + 当前主题` 计算。

### 7.3 明暗主题

Provider Config 只声明一个 `key`，不声明 `lightLogoKey` / `darkLogoKey`。同一品牌是否需要两个主题素材属于打包资源实现细节：

```ts
interface BuiltinProviderLogoAsset {
  readonly light: string;
  readonly dark?: string;
}
```

- 品牌彩色 Logo 在两个主题均清晰时，只提供 `light`，两种主题复用；
- 官方明确提供 light/dark 版本，或单色标记在某主题对比度不足时，同时打包两份；
- UI 根据当前主题选择 `dark ?? light`；
- 不通过 CSS filter、反色或重新着色篡改品牌素材；
- SVG 使用 `<img>` 加载时，不能依赖外部 `currentColor`，需要打包具有明确颜色的文件或分别提供主题版本。
- `system` 主题先由现有主题状态解析成实际 light/dark，再选择资源；Logo Resolver 不建立第三种主题状态；
- Logo 与旁边的 Provider 名称表达同一信息时属于装饰图，使用空 `alt` 并从辅助技术名称中隐藏，避免重复朗读。

### 7.4 Personal 与 Account Provider 边界

Account Provider 不是 Provider Template，不能为了复用 Logo 强行增加 `templateId`。它直接从自己的 Built-in Provider Config 得到 Logo。现有 OAuth 图标 helper 不再作为 Provider 设置页的品牌事实源；OAuth/Login 自身的图标用途可以保留。

纯自定义 Provider 没有 Logo 时使用通用 Package 图标。本轮不提供上传 Logo、填写 Logo URL 或选择内置 Logo 的 UI；以后确有需求再扩展 `ProviderLogoRef`。

### 7.5 首批打包素材集合

第一批内置 key 固定为：

```text
zai
bigmodel
moonshot-kimi
minimax
deepseek
alibaba-model-studio
xiaomi-mimo
openai
anthropic
xai
```

素材原则：

- 优先使用品牌官方提供的 SVG；没有合适 SVG 时使用官方 PNG/JPEG；
- 素材不要求相同源格式或源尺寸；首批位图允许在不裁切、不改图形的前提下缩放为打包尺寸，源素材有透明通道时应保留；
- UI 使用统一方形容器、`object-contain` 和一致留白控制视觉尺寸；
- Z.AI 与 BigModel 复用仓库已有、已经用于正式登录/账号界面的品牌素材；
- Moonshot Kimi 使用 `MoonshotAI/Branding-Guide` 官方资源；首批单素材在两种主题复用；
- MiniMax 使用官方品牌包中的方形素材；
- DeepSeek 使用其官方组织发布的品牌图形，产品发布前确认商标使用授权；
- Alibaba Model Studio 不采用产品分支中来自第三方 GitHub 仓库的图片，改用阿里云/百炼官方素材；中国和国际 Template 复用同一个 key；
- Xiaomi MiMo 使用其官方平台素材；
- OpenAI、Anthropic 使用各自官方网站素材；Anthropic 若使用单色 SVG，需要提供明确的 light/dark 文件，不能把含 `currentColor` 的 SVG 当普通 `<img>` 后期待继承页面颜色；
- xAI 使用官方站点或官方组织素材；
- 产品分支中的来源清单保留为审计线索，但素材只在来源与主题适配复核后重新纳入，不能直接整批复制。

每个打包素材记录品牌、来源 URL、获取日期、文件格式、是否包含透明通道和主题用途。Logo 缺失、资源加载失败或远端配置引用未知 key 时均回退通用图标。

### 7.6 展示面边界

本轮统一 Logo 的展示面固定为：

| 展示面                         | 数据来源                                      | 本轮行为                                        |
| ------------------------------ | --------------------------------------------- | ----------------------------------------------- |
| Provider 左侧导航              | Effective Provider Config                     | 展示 Provider Logo；缺失或未知 key 回退通用图标 |
| Provider 详情标题              | Effective Provider Config                     | 与导航使用同一个 Logo Resolver                  |
| Provider Template 选择页       | Template `config.logo`                        | 展示 Template 基线 Logo                         |
| Account Provider 详情          | Account Provider 的 Effective Provider Config | 不再用 Provider ID 推断 Z.AI/BigModel Logo      |
| Welcome/OAuth 登录入口         | 登录产品自身的品牌资源                        | 暂时保留，不能反向成为 Provider Logo 事实源     |
| 模型选择器、会话消息、任务列表 | 不属于本轮                                    | 不为了“统一品牌”扩展新的 Logo 展示需求          |

所有打包 Logo 放在 Desktop 与 Web 共用的 UI 资源边界，由同一个 Resolver 使用。Renderer 可以维护 `logo key -> 打包资源` 的资源表，但该表只负责加载资源，不包含 Provider ID、名称、排序、Template 成员或 Account 产品规则。

## 8. 明确不纳入

- 不合并或 cherry-pick `feat/provider-ux-refactor`；
- 不引入 Catalog 数据层；
- 不改 Account Provider、Start Plan、Individual Plan、Team Plan 页面结构；
- 不删除或简化套餐介绍、购买卡片、价格、Quota 与 Usage；
- 不改变 Account entitlement、Access、Registry 完整性或模型执行语义；
- 不移动 Model Config Rule，也不改变 Match/Template/Provider/Personal Rule 优先级；
- 不改变 Provider/Model 拖动语义；
- 不改变 Provider 设置页整体宽度、高度和双栏滚动结构；
- 不在本轮增加 Template 搜索。

## 9. 实施顺序

1. 更新 Provider Template、Provider Config 与设置页 Design，并更新 Feature Graph 的 Template/Settings 节点和代码种子，固定领域壳、名称、Logo 状态归属与展示面；
2. 提升 Built-in Release Schema Version，并先补 Provider Template Schema、JSON round-trip、Bundled/Remote 发布解码、Active/LKG 和名称解析测试；
3. 将 `ProviderTemplateMap` 从 `ProviderConfig` 值升级为 `ProviderTemplate` 值；
4. 更新 Built-in JSON，使每个 Template 使用 `{ nameMap, config }`；
5. 更新 Resolver、Config Service、Facade 与 Settings View 的 Template 投影；
6. 更新创建接口，显式接收名称种子并在服务端原子去重；
7. 先补设置页交互 E2E，再实现顶部入口、Template 选择页、返回和创建后落点；
8. 删除未发布的 `logoUrl`，改用 `logo`；整理首批打包素材并接入主题感知的统一资源解析，不增加兼容 importer；
9. 调整侧栏 Logo 尺寸、状态点与“添加模型”位置；
10. 清理旧下拉式 Template 入口和 Renderer Provider ID 名称/Logo/排序表；
11. 全面 Review 不存在 Catalog、Provider enabled 或 Account 页面回退。

## 10. 测试与完成标准

### Config / Provider

- Provider Template 壳严格解析与 JSON round-trip；
- Bundled、Remote、Active/LKG 和 fixture 使用同一个新 Release Schema Version；旧 Template Map shape 不提供兼容读取；
- `nameMap` 当前语言、英文和 `templateId` fallback；
- Template `config` 继续使用正式 Provider Config Overlay Schema；
- Model Config Rule 物理结构与解析优先级不变；
- 同名创建在服务端原子生成稳定后缀；
- 并发创建不能生成相同 `label`；
- `initialConfig.label` 不能绕过去重；
- 创建后切换语言不修改 Personal `label`。
- `logo` 严格接受当前 `builtin` 结构，但 `key` 不做闭集枚举；
- `logo` Overlay、`null` 清除、JSON round-trip 与 Effective Provider 投影正确；
- Template Logo 更新会影响后续 Effective Config，但不会复制或改写 Personal `label`；
- Settings View/Protocol 原样携带 `logo` 引用，不携带解析后的资源 URL；
- 未知 Logo key 不产生完整性错误，也不影响 Registry/executable。
- 未知 Logo type 继续由当前严格 Schema 拒绝，不与未知 key 的 UI fallback 混淆。

### UI / E2E

- 顶部入口打开右侧 Template 选择页；
- 返回恢复原详情；
- Template 发布顺序不变；
- 无搜索入口；
- 中英文 Template 名称正确；
- 单行长名称正确省略、完整名称悬浮提示、Logo 与进入箭头对齐正确；
- 已知 Logo、未知 Logo fallback、缺失 Logo fallback 和 light/dark 资源选择正确；
- System 主题解析后选择正确的 light/dark 资源，单资源品牌在两种主题下复用；
- Logo 不导致 Provider 名称被辅助技术重复朗读；
- 从 Template 创建与纯自定义创建均进入新 Provider 详情；
- Provider 状态点严格反映 `executable`；
- 添加模型位于标题右侧；
- 删除当前 Provider 延续既有 fallback；
- Account Provider 页面和套餐卡没有行为或视觉回归；
- Desktop、Web、手机、Zai Light、Zai Dark 和键盘操作均覆盖。

### 验证

- Provider、Provider Node、Services 和 UI 定向单测；
- 受影响 Desktop E2E；
- `pnpm typecheck`；
- `pnpm lint`；
- `pnpm test:unit`；
- `git diff --check`。

完成后提交 Conventional Commit，并在提交信息中加入真实的 Agent 会话 trailer；未获得 Session ID 时不得猜测。

## 11. 实施结果

- Built-in Release Schema 已提升到 v3、Built-in revision 已提升到 8；Bundled、Remote、Active/LKG 与测试 fixture 原子切换到同一 Template 壳。
- Template 选择页、返回、从 Template/纯自定义创建、创建后落点、Host 原子名称去重和并发去重均已实现。
- `logoUrl` 已从正式 Provider Config 删除，替换为开放 key 的 `logo: { type: "builtin", key }`；未知 key 或资源加载失败只回退通用图标，不影响 Provider 完整性和执行。
- 首批品牌素材已打包到 UI 公共资源边界，来源、归属和缩放方式记录在 `model-provider-logo-sources.json`；当前素材在两种主题下均复用，Resolver 已保留可选 dark 资源位。
- Provider 导航、详情标题和 Template 卡片统一消费 Effective Provider Config/Template config 中的 Logo；Renderer 没有 Provider ID 到品牌的映射。
- 顶部“添加供应商”入口和“添加模型”标题侧入口已完成；旧侧栏 Template 下拉与候选项已删除，Account 页面及删除 fallback 未改变。

### 验证记录

- Provider、Provider Node、Services、Server、UI 定向单测：22 个文件、388 项通过；
- `pnpm typecheck`：通过；
- `pnpm --filter @zcode/desktop typecheck:e2e`：通过；
- `pnpm lint`：通过（仅仓库既有 warning）；
- 全量 Unit：13,071 项通过、25 项跳过；另有 2 个与本 Todo 无关的既有测试基线失败，分别是 E2E CLI seed 环境变量计数和 pre-push hook 命令断言；
- Desktop E2E 已完成应用构建，但当前 Samantha 环境缺少 `xvfb-run`，WebdriverIO 未能创建 Chrome session，未产生用例级结果；
- 修改文件格式检查与 `git diff --check`：通过。
