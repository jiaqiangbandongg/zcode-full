# Todo 62：Provider Template UX Review 收口

> 验证归属更新（2026-09-09）：本文残余欠测/失败/人工晋级统一转交 [Todo102](todo-102-verification-debt-closeout.md)，关闭在本文中的独立验证排期；历史证据保留，转交不代表测试通过。

> 后续 Desktop 图形 E2E 欠测统一由 Todo 78 收口，本 Todo 不再单独排期。

> 状态：已完成（Desktop E2E 因当前 Linux 环境缺少 Xvfb，待在具备图形环境的机器复跑）
>
> 日期：2026-09-02
>
> 前置：Todo 61 已完成 Provider Template 领域壳、选择页、品牌元数据与打包 Logo 的第一版实现。本 Todo 只收口 Review 中已经确认的产品问题和自动化证据，不改变 Provider、Template、Overlay、Registry 或 Model Config Rule 的状态归属。

## 1. 目标

完成 Todo 61 后剩余的四类收尾工作：

1. 所有内建 Provider Logo 使用方形素材，替换不适合方形图标槽的阿里云横向字标；
2. Template 创建失败在 Provider 详情区域内给出明确反馈；
3. 将 Reasoning Level 有序枚举编辑器收紧为紧凑标签；
4. 补齐真实 Built-in Template 创建和品牌展示的交互验证。

本轮保持唯一主链：

```text
Provider Template
├─ nameMap
└─ config: Provider Config Overlay
          |
          v
createPersonalProvider
          |
          v
Personal Provider Config
          |
          v
Effective Provider / Registry
```

不新增 Catalog、品牌 Service、Provider ID 产品映射、Logo 下载器或第二套错误通知系统。

## 2. 内建 Logo 的方形素材契约

### 2.1 硬性要求

所有 `ProviderConfig.logo.type = "builtin"` 对应的打包素材必须满足：

- 素材画布或 SVG `viewBox` 为方形，宽高比为 `1:1`；
- 使用适合图标槽的品牌图形标志，不使用包含完整品牌文字的横向 wordmark；
- UI 继续通过统一方形容器和 `object-contain` 展示，不拉伸、不裁切图形；
- 优先使用厂商公开提供的官方 SVG；没有合适 SVG 时使用官方透明 PNG；
- 素材来源继续记录在 `model-provider-logo-sources.json`；
- 缺失或未知远端 Logo key 仍回退通用 Provider 图标，不影响配置解析、完整性或执行。

机械校验应覆盖打包清单中的所有内建素材：PNG 检查像素宽高相等；SVG 检查方形 `viewBox` 或等价的方形固有尺寸。不能只验证 CSS 容器是方形。

### 2.2 阿里云素材

当前 `model-provider-alibaba-model-studio.svg` 是约 `183.8 × 22.45` 的 `Alibaba Cloud` 横向完整字标。放入 `28 × 28` 的方形槽后，按比例实际只有约 `3.4px` 高，不符合内建 Logo 契约。

替换要求：

- 找到并打包官方的方形阿里云或阿里云百炼/Model Studio 品牌图形；
- 中国与国际 Template 可以继续复用同一个资源 key；
- 不从横向字标中私自裁切或重新绘制图形；
- 替换后在 Zai Light、Zai Dark 两种实际主题中检查清晰度与视觉尺寸。

名称保持：

```text
zh-CN：阿里云百炼（中国） / 阿里云百炼（国际）
en-US：Alibaba Model Studio (China) / Alibaba Model Studio (International)
```

这里连接的是 Model Studio/DashScope 模型服务，仅写“阿里云”范围过宽；Logo 使用阿里云主品牌图形不要求删除产品名称“百炼”。

### 2.3 其他名称结论

- `Z.AI` 中 `AI` 保持大写；
- BigModel 保持正式英文品牌名；
- Moonshot Template 的中英文名称统一为 `Moonshot Kimi`，不使用“月之暗面 Kimi”；
- 其他 Template 延续当前正式英文品牌名；不在 Renderer 按 Provider ID 单独翻译。

## 3. Template 创建反馈

当前 `handleCreateProvider` 捕获失败后只写 UI Logger，用户没有可见反馈。目标行为：

```text
点击 Template / 创建自定义供应商
              |
              v
      Host 原子创建 Personal Provider
              |
      +-------+-------+
      |               |
    成功              失败
      |               |
进入新 Provider       保持 Template 选择页
详情页                显示失败横幅
```

- 失败反馈复用 Provider 设置右侧详情区域底部的既有横幅样式和队列；
- 横幅包含错误图标和可理解的真实错误消息；
- 不在页面顶层、窗口外层或 Template 卡片内部新增另一套 Toast；
- 失败时恢复可操作状态，允许重试或返回；
- 成功行为维持进入新 Provider 详情，不额外弹重复成功消息；
- 日志继续通过 `packages/ui/src/logger.ts` 记录，但日志不能替代用户反馈。

## 4. Reasoning Level 编辑器紧凑化

Reasoning Level `values` 仍然是从低到高的有序数组。本轮只调整交互密度，不改变配置结构、解析、默认值或 Runtime 语义。

当前每个档位由最小高度 `36px` 的外框、较大横向留白和常驻删除区组成，视觉上过重。目标改为紧凑有序标签：

- 档位标签采用约 `28px` 的常见紧凑高度；
- 缩小横向 padding、标签间距和删除按钮占位；
- 删除操作默认弱化，在 hover、focus 或编辑状态下清晰可见；
- 保留点击编辑、添加、删除、拖动排序和键盘操作；
- 保留 `Alt + Left/Right` 作为拖动排序的键盘替代，不显示额外快捷键文案；
- Personal Override 的边框语义继续遵循现有布尔/配置字段样式，不新增“默认/已修改”文字；
- 至少一个值的约束和重复值处理保持当前行为，不借 UX 调整增加新的领域校验。

Reasoning 编辑器测试不能再只用“紧凑标签”作为测试名称，却完全不约束呈现结构；应至少固定紧凑尺寸 class、编辑态尺寸和删除按钮可访问性。

## 5. 自动化补齐

先写失败测试，再修改实现。

### 5.1 Logo

- 清单内所有 Built-in Logo 均满足方形素材契约；
- 阿里云不再引用横向 wordmark；
- 已知 key、未知 key、缺失 key 和资源加载失败行为不变；
- Light/Dark 选择和单素材回退继续正确；
- Template 卡片、Provider 导航和详情标题读取同一个结构化 `logo` 事实。

### 5.2 Template 创建

- Desktop E2E 真正点击一个 Built-in Template，验证创建后进入新 Provider 详情；
- 验证新 Provider 继承 Template Endpoint、API Schema、模型成员和 Logo；
- 验证创建时按当前语言生成名称种子，并由 Host 原子去重；
- 保留纯自定义 Provider 创建覆盖；
- 注入创建失败，验证底部错误横幅、重试能力及页面落点；
- 不以 SSR 静态 HTML 测试替代真实点击链路。

### 5.3 Reasoning 编辑器

- 紧凑标签、编辑态、添加、删除、拖动和 `Alt + Left/Right`；
- 顺序变化继续直接写入当前 Draft，不出现先回位再跳转；
- 中英文、键盘、Light/Dark 与窄宽度布局不溢出。

## 6. 非目标

- 不修改 Reasoning `values[0]` 表示最低档位的语义；
- 不引入 `reasoningLevelPolicy` 或其他策略抽象；
- 不改变 Provider Template、Personal Overlay 或 Registry 解析优先级；
- 不增加 Template 搜索；
- 不修改 Account Provider 页面和套餐卡；
- 不增加用户上传 Logo 或远端任意 URL Logo；
- 不恢复 Provider `enabled` 或设置页 Provider Switch；
- 不借本轮处理与 Provider 无关的全仓测试基线。

## 7. 完成标准

- 内建资源清单不存在非方形 Logo，阿里云使用可追溯的官方方形素材；
- Template 创建失败有统一、可见、可重试的底部反馈；
- Reasoning Level 编辑器明显收紧，同时完整保留有序编辑能力；
- Built-in Template 与纯自定义 Provider 的真实交互链路均有 E2E 证据；
- Provider、Provider Node、Services、UI 定向单测通过；
- `pnpm --filter @zcode/desktop typecheck:e2e` 通过；
- 受影响 Desktop E2E 在具备图形环境的机器或 CI 中实际执行通过；
- `pnpm typecheck`、`pnpm lint` 和 `git diff --check` 通过；
- 完成后提交 Conventional Commit，并在提交信息中加入真实的 Agent 会话 trailer。

## 8. 实施结果

### 8.1 Logo 与名称

- 新增内建 Logo 素材机械校验：PNG 读取固有像素尺寸，SVG 读取 `viewBox` 或固有尺寸，清单内资源必须为 `1:1`；
- 将阿里云横向完整字标替换为阿里云官方 GitHub 组织使用的方形品牌图形，并以 `80 × 80` 透明 PNG 随应用打包；
- 素材来源、所有者与归一化过程继续记录在 `model-provider-logo-sources.json`；
- Moonshot Template 的中英文名称统一为 `Moonshot Kimi`；
- Built-in Config revision 从 `8` 提升为 `9`，确保名称更新能进入正式发布与刷新链路。

### 8.2 Template 创建反馈

- Template 与纯自定义入口都等待同一个 Host 创建 Promise；
- 创建失败时保留 Template 选择页，并复用 Provider 详情底部的反馈横幅展示真实错误与重试操作；
- `ModelProviderSection` 继续记录 UI 日志，同时把错误返回给交互层，不再出现“日志知道失败、用户什么也看不到”的断链；
- 新增真实点击交互测试，固定失败横幅与重试行为；Desktop E2E 增加 Built-in DeepSeek Template 的真实创建、Endpoint、Schema、模型顺序和 Logo 断言。

### 8.3 Reasoning Level 编辑器

- 档位标签收紧为 `28px` 级别高度，缩小间距、横向留白、编辑输入和删除按钮；
- 删除按钮默认弱化，仅在 hover/focus 时显示，语义与可访问名称保持不变；
- 修正原测试文件扩展名不符合当前 Vitest include、实际上从未被收集的问题；新测试真实覆盖紧凑尺寸、键盘排序、拖动、编辑、添加、删除和 Personal Override。

## 9. 验证记录

- Provider/UI 定向测试：`5` 个文件、`15` 条测试全部通过；
- `pnpm --filter @zcode/ui exec tsc --noEmit`：通过；
- `pnpm --filter @zcode/desktop typecheck:e2e`：通过；
- `pnpm typecheck`：通过；
- `pnpm lint`：通过，只有仓库既有 warning；
- 本轮修改文件的 `oxfmt --check`：通过；全仓 `pnpm fmt:check` 仍被 `docs/electron` 的既有非法 HTML 与 `apps/zcode-cli/tests/gb2312.js` 读取失败阻塞；
- `pnpm test:unit:affected`：因相对 staging 存在已删除文件而升级为全量 unit；`1531` 个文件通过、`1` 个跳过、`2` 个失败，合计 `13078` 条测试通过、`25` 条跳过。两条失败分别是既有 pre-push `mise-run` 断言和 E2E CLI Config 常量计数断言，均不涉及本 Todo 修改；
- Desktop 设置 E2E：应用与 Agent 构建成功，但当前 Linux 环境缺少 `xvfb-run`，Chromedriver 在执行任何 case 前无法创建图形会话；该结果属于执行环境阻塞，不代表 case 断言失败；
- `git diff --check`：通过。
