# Login Page

启动阶段如果没有恢复到 OAuth 用户，且没有可用模型供应商配置，Root 会展示 `WelcomeScreen`。

所有应用内登录入口都收敛到 `WelcomeScreen`，并复用 `LoginPanel` 的 OAuth 和 API Key 流程，避免手动登录、启动引导、模型供应商连接出现多套状态机：

- 启动自动引导：`WelcomeScreen`，由 provider 可用性守卫打开
- 手动登录入口：`WelcomeScreen`，从设置页或 workspace shell 的登录操作打开
- 模型供应商连接：`loginEntryRequest` 会打开 `WelcomeScreen` 并自动启动指定 provider 的 OAuth
- 登录内容容器：使用 `bg-background`、`border-popover-border`、`shadow-md`

完成 OAuth 回调、保存 API Key 或点击 API Key 表单底部的“跳过”后，登录页关闭并回到正常 Root 路由。

用户点击“跳过”或从其它入口进入没有可用模型的空草稿首页时，首页必须展示已有的 `modelConfigMissing` 错误横幅，提供升级和模型配置入口。该横幅只投影本地 provider readiness，不触发 Agent 启动、deferred draft session 创建、联网探测或预热失败重试；保存合法 provider/model 并完成草稿模型水合后自动清除。

空草稿同时展示 workspace / Git context header 时，错误横幅必须作为独立 surface 位于输入卡外壳上方，不能嵌入包裹 context header 与编辑器的圆角卡片；横幅与输入卡之间固定保留 `mb-6`（24px）间距。视觉顺序固定为“错误横幅 → 独立间距 → 选择工作区 / Git 分支 → 输入框”。桌面端和手机 Web 端使用同一 DOM 顺序与容器层级；响应式布局只能改变换行和密度，不能把错误横幅移动到工作区入口下方或重新并入输入卡外壳。

API Key 登录表单在输入框为空时于右侧展示 `Get API Key` 外链入口；用户已经输入或回填 API Key 后隐藏该入口，避免链接占用密钥编辑空间。链接目标跟随当前选择的 provider：

- Z.ai：`https://z.ai/manage-apikey/apikey-list`
- BigModel：`https://bigmodel.cn/apikey/platform`

首次进入 API Key 登录表单时，provider 默认值只根据当前 App 已解析的 `locale` 决定：简体中文（`zh-CN`）默认选择 BigModel，英文（`en-US`）默认选择 Z.ai。`locale` 已包含“跟随系统”语言偏好的解析结果，因此表单不再单独读取系统语言或 provider 历史配置。该规则只负责表单初始化；用户手动切换 provider 后，不得因语言广播覆盖当前选择。

外链必须通过 `IPlatformService.openExternal()` 打开，保持桌面端 shell 和 Web 端 `window.open` 行为一致。输入框仍保留密码类型和回车提交能力，链接按钮只负责跳转获取密钥，不参与保存流程。

API Key 登录表单的取消按钮底部展示“跳过”链接按钮。跳过只写入当前选择 provider 对应的 `providerFamilyDomain`、`providerFamilyDomainUpdatedAt` 和 `providerFamilyDomainMigrated`，用于确认 Z.ai / BigModel 运行域；它不保存 API Key、不触发 API Key 登录成功事件，也不修改 `modelProviderFamilyModes`。

启动自动引导完成后有一个新用户直达路径：如果当前没有已打开 workspace，Root 使用 Main 注入的 conversation descriptor，必要时通过 `fileService.ensureConversationWorkspace()` 幂等确保 `<dataBaseDir>/.zcode/workspace/default` 存在。该 workspace 提供真实 cwd，但 UI 保持“未选择项目”，用户无需经过项目选择页即可直接对话。若用户跳过登录且仍没有可用模型，该草稿首页按上一条规则显示 `modelConfigMissing` 横幅。

手动登录和模型供应商连接完成后只关闭 `WelcomeScreen` 并回到原界面，不会创建默认 workspace。
