# 用户引导埋点 Spec

日期：2026-09-18。状态：已接入引导组件与公共上报链路，真实客户端及接收端待人工验收。

## 目标与事件

记录整次引导曝光和结束时的选择，复用公共业务埋点链路。

| 事件 | element_name | event_region | event_type | event_text |
| --- | --- | --- | --- | --- |
| 引导曝光 | onboarding_expose | app.onboarding | expose | 空字符串 |
| 引导结束 | onboarding_end | app.onboarding | ck | 操作时按钮文案或关闭入口的本地化标签，必填 |

埋点表中的 `event_element` 对应现有请求字段 `element_name`，调用参数为 `elementName`，不新增同义字段。结束事件的 event_text 必须使用点击时用户看到的按钮文案，与按钮复用相同的 i18n 翻译结果，不写死中文、英文或翻译 key；随选择快照一起捕获，避免异步保存期间切换语言导致文案不一致。统计操作类型以固定英文 exit_action 为准。

关闭入口为图标按钮，event_text 复用其 title / aria-label 的 `occupationOnboarding.close` 翻译：当前中文为“退出引导”，英文为“Exit onboarding”。Esc 和引导快捷键主动收起也使用同一关闭标签，不传空字符串或按键名。

- 首次自动展示、后续从设置点击“引导”、快捷键手动打开以及按现有规则再次自动展示，均在引导真正可见时曝光一次；不限定首次使用应用。异步判定、预填、重渲染、切换步骤和返回不重复曝光。关闭后显式重新打开算新一次；仅点击入口但未实际展示不报曝光。
- 第三页点击开始使用或跳过，偏好保存成功、引导结束时上报 end 一次。点击时捕获选择快照，不能从保存后的保守默认值或本地 record 反推选择。
- 保存失败仍停留在引导中，不报 end；成功重试只报一次。本地 record 追加失败不影响已成功结束的事件。
- 当前前两页跳过只是进入下一页，不触发 end；被跳过的单选页记为空，用户返回重新确认后使用新答案。
- 右上角 X / Esc / 引导快捷键主动收起均上报 end，exit_action 为 close，携带关闭时的选择快照和所在步骤；保持直接退出不保存 settings、不写 record、不标记完成的既有语义。退出前发起上报，不等待网络。关闭应用、崩溃或非用户操作的卸载不伪造 close。
- 同一次引导最多产生一个 end，start / skip / close 共用结束去重；保存中禁用关闭的既有行为保持不变。曝光与结束的差额表示没有成功收到结束事件的样本，可能包含异常中断或上报失败。
- 埋点失败不得阻塞引导或配置保存，沿用公共上传重试策略，不新增业务层重复重试。

```text
引导实际显示 -> expose（一次）
    -> 工作方向 -> UI 模式 -> 工作助手偏好
         跳过 ----> 下一页       |
                        start / skip：捕获选择快照
                               |
                         settings 保存
                      失败 /          \ 成功
                    留在引导           end（一次）
                                       -> 原有结束流程
任意页 X / Esc / 引导快捷键收起
    -> 捕获已有选择 + 当前步骤
    -> end(close，一次，不等待网络) -> 直接退出，不保存配置或记录
```

## event_extra_detail

曝光事件使用空对象。结束事件固定包含以下字段：

| 字段 | 逻辑取值 | 含义 |
| --- | --- | --- |
| work_direction | 下表枚举 / null | 已展示页面的当前工作方向；跳过且未重选为 null |
| ui_mode | work / code / null | 办公 / 编程；未展示或跳过且未重选为 null |
| proactive_task_recommendations_enabled | boolean / null | 主动任务推荐勾选状态，仅办公模式展示 |
| workspace_memory_enabled | boolean / null | 工作区记忆勾选状态 |
| claude_code_history_migration_selected | boolean / null | 迁移会话数据勾选状态，不表示迁移完成 |
| exit_action | start / skip / close | 结束入口 |
| exit_step | 1 / 2 / 3 | 结束时所在页；start / skip 为 3，close 可为任意页 |

模式只在埋点边界映射：内部 `office -> work`、`coding -> code`；不更名 settings、store 或 record 中的模式。

偏好字段：展示且勾选为 true，展示但未勾选为 false，未展示为 null。编程模式或跳过模式页导致推荐选项隐藏时，推荐字段为 null，不能算作主动关闭。默认或预填勾选也计入最终状态，不表示主动点选。第三页点击 skip 仍上传当时三个选项的状态，不统一置空，也不表示这些选项已应用。

close 同样记录当前选择，不要求当前页先点下一步：例如首次进入第一页面后关闭，上传当页已显示的默认/预填或手动选择，模式和三个偏好字段为 null；第二页关闭可上传工作方向与当前模式，尚未展示的偏好为 null。已访问后返回的页面保留本次选择，不能仅根据 exit_step 推断哪些页展示过。返回修改模式时应使与新模式不一致的旧偏好快照失效，未在新模式下展示确认的偏好记 null。以上均为选择快照，不代表保存或启用成功。

**传输格式**：现有 `TelemetryEventPayload.eventExtraDetail` 为 `Record<string, string>`。复用此接口，各值编码为字符串：布尔为 `"true"` / `"false"`，空值为 `"null"`，页码为 `"1"` / `"2"` / `"3"`。不省略空字段、不传 JS undefined，也不把整个对象二次 JSON 序列化。上述逻辑类型用于解释含义；实际查询按字符串比较。若未来采用原生布尔/null，需整体评估并升级公共接口，不能只在本事件强制类型转换。

### 工作方向映射

| 中文文案 | 内部 occupation | work_direction |
| --- | --- | --- |
| 软件开发/数据/AI | developer | software_data_ai |
| 创业/自由职业/OPC | independent | entrepreneurship_freelance_opc |
| 测试/运维/安全 | infrastructure | qa_operations_security |
| 产品/项目/解决方案 | product | product_project_solutions |
| UI/UX/视觉设计 | design | ui_ux_visual_design |
| 学生/教师/科研 | student | education_research |
| 金融/财务/咨询 | finance | finance_accounting_consulting |
| 自媒体/内容创作 | creator | media_content_creation |
| 运营/电商/客户服务 | operations | business_operations_ecommerce_customer_service |
| 市场营销/品牌/公关 | marketing | marketing_brand_pr |
| 法律/行政/人力资源 | legal | legal_administration_hr |
| 其他职业 | other | other |

不修改内部职业枚举。显示文案或语言变化不能改变上报枚举。other 只表示明确选择其他职业，不能替代未作答。

## 公共身份字段与链路

两个事件都必须通过公共层携带顶层 `user_id`、`device_mid`，不放进 event_extra_detail。

- user_id：沿用公共层当前账号身份加载；没有账号身份时沿用空字符串，不伪造用户 ID、不用设备 ID 替代。实现和验收必须检查登录用户的请求中有真实账号 ID，以及匿名情况下仍有该字段。
- device_mid：复用 telemetry-state 中持久化的公共设备标识，由 `ensureTelemetryDeviceMid` 提供；不生成引导专用 ID，不复用 event_id，也不改用 `platform.getDeviceId()`。本地 onboarding-record 文档中的 deviceMid 来源与公共埋点设备标识不同，不应混用。
- 每条事件使用公共事件 ID 和公共上下文，不新增独立上报接口。

```text
OccupationOnboarding
  -> reportAppTelemetryEvent / usePlatform
  -> IPlatformService.reportTelemetryEvent
  -> Desktop 公共 TelemetryCore
       + 当前 user_id
       + 持久化 device_mid
  -> 既有 event/report 请求
```

请求示例（仅列相关字段，身份值为占位符）：

```json
{
  "element_name": "onboarding_end",
  "event_region": "app.onboarding",
  "event_type": "ck",
  "event_text": "开始使用",
  "user_id": "<current-user-id>",
  "device_mid": "<shared-telemetry-device-id>",
  "event_extra_detail": {
    "work_direction": "product_project_solutions",
    "ui_mode": "work",
    "proactive_task_recommendations_enabled": "true",
    "workspace_memory_enabled": "true",
    "claude_code_history_migration_selected": "false",
    "exit_action": "start",
    "exit_step": "3"
  }
}
```

## 与本地记录和多端的边界

本地 record 的跳过语义继续遵循 [引导记录 Spec](../onboarding-record-spec.md)：偏好页跳过写 null，settings 落保守默认值。本事件记录用户结束时看到的选择，两者目的不同，不能直接上传 record 替代本事件。本期不实现 record 的 uploadState 上传队列。

UI 通过现有平台抽象调用，Web/手机沿用自身适配器能力，不直接访问桌面 bridge 或新建 Host/runtime；不改变桌面 continuous 或手机 replayable 消息流。布局、交互、主题、国际化及 Windows/macOS/Linux 配置行为保持原状。

## 实现顺序与验收

先编写以下场景测试，再接入事件，最后做运行时请求验证：

1. 12 个职业映射完整；office/coding 映射 work/code；跳过单选页传字符串 null，其他职业为 other。
2. 工作模式三个开关分别支持勾选/取消；code 模式推荐为 null；模式切换后隐藏选项不泄露旧值。
3. start 与第三页 skip 均保留点击时的快照；skip 不触发迁移，勾选迁移不代表迁移成功。
4. 首次自动展示与设置/快捷键打开均产生曝光；前两页 skip、返回、重复渲染不产生结束事件或重复曝光；保存失败不报结束，重试成功一次；重复点击不重复上报；显式重开产生新曝光。
5. 分别在三页用 X / Esc / 引导快捷键收起，均只报一次 close，exit_step 正确；已展示的选择保留，未展示字段为空，返回及改模式后不泄露失效偏好；不写 settings/record、不触发迁移、不标记完成。关闭应用或卸载不伪造 close；上报失败不阻断退出。
6. 在真实公共请求体核验两事件均含 user_id、device_mid；已登录账号正确、匿名保留空 user_id；同设备两事件的 device_mid 一致且重启稳定。日志/抓包展示时遮蔽真实身份。
7. 运行 pnpm typecheck、pnpm lint 及相关单测；验证桌面 work/code、深浅主题与手机适配器不受影响。无法完成的跨平台或运行时验证明确记录，不以静态阅读代替。
8. 中英文下 start / skip / close 的结束事件 event_text 均非空，且等于操作时按钮实际文案或关闭标签（退出引导 / Exit onboarding）；exit_action 不随语言变化。异步保存期间切换语言不能改变已捕获的 event_text。

## 落地点与回归用例

`OccupationOnboarding` 保持选择状态的唯一 owner；`useOnboardingTelemetry` 仅在 layout effect 中记录实际展示的步骤、当前模式和同次结束去重，不持久化第二份答案。保存入口先冻结快照，settings 成功后发送 end；close 直接发送。结束后将步骤复位，避免重开时沿用上次已展示范围。

| 用例 | 设置与操作 | 断言 | 自动化位置 |
| --- | --- | --- | --- |
| ONBT-01 | 首次自动/手动打开、StrictMode、切页、重开 | 每次实际打开一次曝光，未展示无曝光 | UI occupationOnboardingTelemetry.test.ts |
| ONBT-02 | 三步选择后 start/skip，保存失败重试 | 成功后一次 end，点击时的答案和语言保持，迁移意愿不等于成功 | 同上 |
| ONBT-03 | 任意页关闭、返回改模式再关闭 | close 与页码正确，未展示/失效偏好为空，不保存 | 同上 |
| ONBT-04 | 公共 Core 上报匿名/登录事件 | 顶层 user_id/device_mid，重建 Core 后设备标识一致 | services telemetryService.test.ts |
| ONBT-05 | 桌面真实引导重开，close/start/skip | 实际请求体与接收端事件，身份及字段完整 | 用户手动验证 |

本次按用户要求不以 E2E 为验收项，使用组件交互测试与公共 Core 请求体测试验证代码；真实客户端及生产接收端由用户手动验证，尚未验收。Web/手机继续复用原平台适配器能力，未新增独立上传出口。
