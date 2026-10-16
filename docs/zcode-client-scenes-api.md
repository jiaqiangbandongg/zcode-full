# ZCode Client Scenes 接口

## 目标

App 服务层注册 ZCode Client Scenes 接口，供后续场景消费方通过统一的
`ApiClient` 请求出口读取服务端场景配置，避免业务代码硬编码测试域名或绕过 ZCode
通参注入。

## 请求契约

- 方法：`GET`
- 路径：`/api/v1/client/scenes`
- 测试环境示例：`https://zcode.z.ai/api/v1/client/scenes`
- URL 必须通过 `buildRuntimeZCodeApiUrl(process.env, path)` 构造，使生产、测试以及
  运行时 endpoint override 继续遵循现有环境切换规则。
- 调用方必须使用注入的 `ApiClient` 发起请求。`NodeApiClient` 在请求命中当前 ZCode
  endpoint 时统一注入来源通参、设备标识和 request id；调用方不得重复手写这些
  headers。
- 本接口不要求新增 query 参数或 Authorization header。

## 响应边界

接口成功响应使用 `ClientSceneResponseBody<ClientSceneConfig[]>`：`{ code, msg, data }`。
`data` 是服务端动态下发的场景数组，允许为空。Service 层不解释具体 scene；各 UI 消费方
只匹配自己声明的 scene 与 option key，未知配置必须忽略。

- `ClientSceneConfig`：`namespace`、`scene`、`options`；`created_at` / `updated_at` 可选。
- `ClientSceneOption`：i18n `contents`；`prompts`、`items`、`templates` 与级联筛选的
  `refer` / `cascades` 均按 scene 可选。
- `ClientSceneItem`：i18n `contents` / `labels`；`descs`、完成事件、Lucide 图标名、兼容保留的
  `imgs` 及分享链接按 scene 可选。
- `on_finish`、`img` 可缺省或为 `null`；`imgs` 以及其中的 `cn` / `en` 均为可选字段。

## 范围

App 服务层通过独立的 `clientScenesService.list()` 暴露只读查询；服务内部使用统一
`ApiClient`，UI 不直接调用 `fetch`，也不接触 Host 端点常量。

Renderer 的多个 React 消费方通过共享 `useClientScenesResource()` 读取同一份原始
`ClientSceneConfig[]`。该资源使用 SWR 的 renderer-memory cache，以当前注入的
`IClientScenesService` 实例作为 authority 隔离边界：相同 Service 实例的并发挂载只发出一次
`list()`，Service/Host attachment 替换后使用新的 cache key，不复用旧 authority 的结果。
缓存不写入 localStorage、automation、off-peak 或 session 持久化。

模板配置属于低频更新数据。成功结果在 10 分钟 dedupe 窗口内直接复用；不轮询，窗口重新聚焦或
网络恢复时允许 SWR 在窗口外重新校验。冷启动没有缓存时消费方进入 loading；已有缓存时立即展示
last-known-good 数据并在需要时后台重验，不退回骨架。网络错误或 `code !== 0` 均视为本次重验失败：
保留已有缓存；冷启动失败才降级为空目录，且不得阻断 Composer 或任务的手动创建入口。

Desktop macOS 点击关闭按钮时主窗口会被隐藏而不是销毁，renderer 及其内存缓存仍存活。共享资源层
必须监听 Page Visibility：只有实际经历 `hidden -> visible` 才把当前 Scene 缓存标记为失效，并按
Service authority + SWR cache authority 合并为一次强制重验；普通 focus 且未隐藏仍沿用 10 分钟节流。
强制重验绕过去重窗口，但请求期间继续展示 last-known-good，失败也不清空已有目录。Web 标签页与
手机浏览器从后台恢复时使用同一语义；仅首次收到 visible、重复 hidden 或重复 visible 均不得额外请求。

`ConversationDraftSuggestedPromptsContainer` 在当前 workspace RPC 就绪后调用
`clientScenesService.list()`，并把 `scene === "draft-suggestion"` 的 `options.prompts.items` 映射为推荐提示词；
旧的 `ai-writing` 不再作为该入口的 fallback。
映射细节和失败边界见 `docs/ui/conversation-draft-suggested-prompts.md`。

`AutomationsSection` 与 `OffPeakNewTaskEntry` 还消费两个明确 scene：

- `scheduled-task`：prompt item 的 `labels` 是标题、`contents` 是 description/instructions；
  `defaults.cronExpr` 反向引用 `options.cronExpr.items`，cron 只取被引用 item 的 `contents`，
  UI 先校验 Service 合法性和 Automation 编辑器无损往返能力，再用本地调度描述器展示，忽略 cron item `labels`。
- `off-peak-task`：prompt item 的 `labels` 是标题；仅 New task 首页卡片 description 按 locale
  优先取 `descs`，对应语言缺失或空白时回退 `contents`；Automations 卡片 description 与创建草稿的
  instructions 始终取 `contents`；
  Automations 只展示远程目录并在空目录时显示「无可用模板」；New task 首页在远程映射后追加本地
  Customize，若远程目录已经包含 Customize 则不重复追加。
  Customize 的稳定标题和描述只通过 `offPeak.newTask.template.customize.title` /
  `.description` 在渲染时走 intl，目录映射不再保存另一份 cn/en 文案。

`draft-suggestion`、`scheduled-task` 与 `off-peak-task` 的 prompt item 均把 `img` 解释为 Lucide
canonical 名称（kebab-case，例如 `file-text`），不得再把它作为图片 URL 请求。首页与 Automations 面板
按名称动态加载 SVG，图标使用 `currentColor` 继承所在图标槽的语义字色；`img` 缺失、空白、名称不属于
当前 Lucide 版本或模块加载失败时，必须回退到各入口已有的本地 Lucide 语义图标。`imgs` 不参与这些
入口的图标选择。

```text
ClientSceneItem.img
  -> trim + Lucide canonical name allowlist
     -> known name ----> dynamic Lucide SVG ----> currentColor
     -> missing/unknown/load failure ----------> surface-local Lucide fallback
```

两种 scene 中 `labels.cn` / `labels.en` 均为空的 prompt item 必须拒绝，不得进入卡片或创建表单。

两者都只提供候选模板。点击只把当前 locale 的普通字符串复制到表单草稿；scene/item/default
元数据不进入 automation 或 off-peak 持久化。请求失败不得阻断手动创建。

```text
React consumer mount / workspace attachment change
  -> useClientScenesResource(service authority)
     -> cache hit --------------------------> 立即返回 last-known-good scenes
     -> cold miss -> SWR dedupe -> clientScenesService.list()
                                  -> Host ApiClient + ZCode 通参
                                  -> GET /api/v1/client/scenes
  <- success: 更新共享内存缓存 -> 各消费方独立映射自己的 scene
  <- failure: 热缓存保持旧值；冷缓存返回空目录
  -> Service authority 已切换：旧 key 的迟到结果不能进入新 key
```

本次不改变 Desktop/Web/手机远控的 session、stream 或 workspace 状态链路。桌面本地
workspace 与 desktop-attached remote workspace 都使用桌面 Host 的 app-global scenes
服务；server remote 使用 server 权威服务。
