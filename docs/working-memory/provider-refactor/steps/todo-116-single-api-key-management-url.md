# Todo116：移除团队专用 Key 链接，统一获取入口

> 状态：2026-09-12 全链路复审、本地整批门禁、Pro 真实设置页到系统浏览器的原生打开验收完成。手机登录控制台与远控联合实机未测，不冒称通过。实现提交：`5123ebc5a5`。
>
> 2026-09-11 用户纠正 Todo111：全面移除团队专用字段，不能只隐藏按钮。

## 裁决与边界

- Access 只保留 `apiKeyManagementUrl` 一个获取 Key 的链接字段；删除团队专用字段的 Schema、类型、Overlay、序列化、模板配置与 UI 透传。
- 所有预设模板统一显示一个“获取 API Key / Get API Key”按钮；有无已填写 Key 都不影响入口显示，不根据账号、套餐、域名猜测链接。
- 沿用各模板原有 `apiKeyManagementUrl`，个人／团队不再分入口。Z.ai Coding Plan 为 `https://z.ai/manage-apikey/apikey-list`，BigModel Coding Plan 为 `https://bigmodel.cn/coding-plan/personal/overview`；普通 API 及其他模板的现有主链接不变。不宣称控制台无需用户切换团队。
- Built-in 模板仍是默认链接来源，现有配置解析与模板详情消费同一字段，复用平台打开外部链接的能力；不新增导航状态或服务路径。
- 不为未上线的双入口中间态增加别名、迁移或宽松解析；不改真实用户文件。Schema 保持 strict，不再接受已删除字段。
- 不改 Key 内容、Provider 身份、Access 类型、个人／团队签名、账号连接或模型配置；不顺便实施 Todo115。
- 桌面、手机 Web 使用同一组件和本地化；不改变 Host attachment、continuous/replayable 或同步时序。

## 验证

- [x] 先更新并运行失败测试：旧字段被拒绝；唯一主链接 Overlay、清空、Registry 序列化和配置往返正确；发布模板均无额外链接字段。
- [x] 删除产品代码及双按钮 props、翻译；Builtin revision 递增，现有主链接原样保留。
- [x] 更新并运行浏览器交互：中英文、窄屏浅色／宽屏深色；有 Key 和无 Key 均只有一个入口，点击交付配置里的主 URL。
- [x] 同步 Todo111、设计规范与用例矩阵，清除双入口的过时要求；全仓排查残留，负向测试和本次纠正说明不算实现残留。
- [x] 批量执行定向单测、浏览器回归、typecheck、lint、架构检查及 E2E 类型检查；代码与当时记录已提交。
- [x] 完成整项 review：重新核对全部裁决、字段删除影响面与 Provider 抽象边界，不以此前初步复审代替最终结论。
- [x] 完成整项验收：核对实际应用中的单入口、目标 URL 及多端验证边界，明确剩余限制后再关闭 Todo。

## 实施与证据

- 删除 Schema、配置对象、Overlay、Registry 序列化及 UI 的团队专用链路；两处 Built-in 模板删除团队链接，发布 revision 19 → 20。全仓检索仅剩拒绝旧字段／断言模板不含该字段的测试。
- 测试先红：两种手动 Access 仍接受旧字段、模板仍含旧字段，共三处预期失败；实施后 Provider / Provider Node 全套和 UI 链接、表单边界、Key 持久化、模板选择定向回归 **42 文件、454 项通过**。
- 浏览器共享组件回归 **2/2 通过**：390px 中文浅色、1200px 英文深色，有 Key／空 Key 均一个按钮，交付原主链接；同时保留启停、横拖、删除失败重试及提示关闭断言。新增清空 Key 操作放到其他操作之后，避免测试自身的异步保存与删除门禁竞争；未为此修改产品保存逻辑。
- `pnpm typecheck`、desktop `typecheck:e2e`、架构检查通过（0 violations）；`pnpm lint` 0 errors，41 项既有 warnings。Builtin 完整性测试的发布版本断言同步更新。
- 当时初步复审记录（完整 review 仍待完成）：无新增账号判断、独立链接状态、签名分支或持久化迁移；除被删除字段外，原有主链接、Key、Access、模型和平台打开链路保持不变。
- 验证边界：浏览器 fixture 使用真实共享组件和隔离写入路由，外部打开回调记录 URL；未在 Air／真实手机或登录后的控制台验证。未写真实用户数据，pending 用例未晋级正式 Electron 回归。

## Goal 复审（2026-09-11）

全仓产品链再次检索，团队字段仅存于两处严格拒绝/模板不含字段的负例。Schema → Access 类/Overlay → Resolver 序列化 → 表单投影 → 单按钮 → 既有平台打开链均只有主 URL；没有前端硬编码第二链接、宽松读取或迁移。两类手动 Access 均保留主 URL/清空语义与 Key，账号身份和签名不变。

六文件49项重跑通过（Provider schema/Overlay/Registry/模板、Node codec/实际发布配置）；本批18项浏览器全部通过，其中两项实际单入口、有/无 Key、点击交付 URL。根类型/lint/架构随131组通过。桌面原生打开和真实手机登录控制台未实跑，限制仍如上，不将浏览器回调当作实机证据；并入 Goal 最终应用验收。

## Pro 原生链验收（2026-09-12）

新增 pending `provider-key-native-open.test.ts`，K116-N01 通过：隔离真实 Personal Config → Settings View → 唯一按钮 → 平台接口/preload/main IPC → 未 mock 的 `shell.openExternal` → 系统默认浏览器 GET 到本机随机端口的唯一 canary 路径。普通 API Key（非空）及 Coding Plan API Key（空）两个模板实例均通过；点击前未访问、点击后精确命中，配置文件字节不变。不会请求模型、登录账号或读取浏览器其他页面；官方模板 URL 的精确值复用此前配置/Schema 测试。

日志 `/tmp/provider-20260912-pro-native-key2.log`，产物 `/Users/dev/provider-stabilization-pro.euQzIZ/packages/desktop/.e2e-artifacts/provider-20260912-pro-native-key2/summary.md`。复用上一轮从 `fc757c0ec9` 构建的 App；本轮无产品代码变更，新增测试及 manifest 单独同步。首次测试未写 templateId 而没有按钮，核对产品“仅模板显示入口”规则后修正夹具，不放宽 UI 或 Schema。未擅自晋级正式回归。

复审：canary 只能从真实点击后的系统浏览器抵达，非 Renderer 回调 stub 或测试主动 fetch；两类 Access 同一测试路径，未新增生产状态／同步／签名分支。手机宽度双主题真实组件点击已有通过证据，真实手机登录控制台仍不在本次证明范围。

最终补断言“canary 未进入任何 Electron WebContents、主设置页仍在”后重跑通过：`/tmp/provider-20260912-pro-native-key3.log`。该 run 的网络记录中模型请求为 0；未复跑无新增证明价值的整批业务测试。根 typecheck、desktop typecheck:e2e、lint（0 errors/42 既有 warnings）、architecture（0 violations）及 conversation coverage audit 通过。`e2e:fixture:check` 不支持 settings 目录，按工具限制保留未通过记录；另检查本例 manifest 的 no-provider 契约，未放宽检查器或晋级 pending。
