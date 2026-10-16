# Team Plan E2E Cases

本文记录 Team Plan 接入后，桌面端设置页和用量入口需要覆盖的 E2E case。范围限定在 desktop local workspace，接口使用 WDIO case-local mock server，不访问真实 BigModel / Z.ai 套餐接口。

## 覆盖原则

- 每条 case 都必须有独立 setup、action、assert，不把“路径经过”视为覆盖。
- Team Plan 的额度和统计必须使用团队项目上下文：`organizationId`、`projectId`、团队 header、`type=2`。
- 个人 Coding Plan 与 Team Plan 同时存在时，各自作为独立 Provider 展示和承载产品数据。
- E2E mock server 记录业务请求，用于断言是否请求了企业套餐列表、个人 quota、团队 quota、模型用量和工具用量。

## Accepted Cases

| Case   | 场景                                                       | Setup                                                                           | Action                                                                   | Assertions                                                                                                                                                     |
| ------ | ---------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CTP-01 | 登录后获取套餐列表；不进入设置页也会触发 Team Plan pricing | 已登录 BigModel，当前 provider 为 BigModel Coding Plan，mock 返回已购 Team Plan | 启动默认工作区，不打开设置页                                             | mock server 收到 `/subscription/enterprise/v2/pricing`；页面仍停留工作区                                                                                       |
| CTP-02 | 设置页连接方式展示按量 API、个人 Coding Plan 与 Team Plan  | 已登录 BigModel，mock 同时返回个人与 Team Plan                                  | 打开模型设置并展开连接方式；选择 Team Plan                               | 菜单包含三类正式连接；设置保存结构化 `providerFamilyConnectionSelections.bigmodel`，不写旧 `mode/selectedKey`                                                  |
| CTP-03 | 用户头像菜单进入 Team Plan 使用统计                        | mock 返回 Team A quota，当前连接方式为 Team A                                   | 点击用户头像菜单里的使用统计入口                                         | Usage 页切到 Team Plan 编程套餐，显示 Team A 名称和剩余额度百分比；mock 收到 `quota/limit?type=2`                                                              |
| CTP-04 | 设置 → 使用统计 → 编程套餐显示 Team Plan 用量              | mock 返回 Team A quota、model usage、tool usage                                 | 打开设置页 → 使用统计 → 编程套餐                                         | 页面显示 Team A 额度、模型用量、工具用量；mock 收到 `quota/limit?type=2`、`model-usage?type=2`、`tool-usage?type=2`                                            |
| CTP-05 | 个人/团队套餐组合跟随当前 Family 连接展示                  | mock 同时返回个人与 Team Plan                                                   | 在设置页切换个人 Coding Plan 与 Team Plan                                | 产品卡、quota 与模型成员跟随当前结构化 connection selection；不由旧 selectedKey 或 Personal Account Provider 决定                                              |
| CTP-06 | OAuth 启动恢复保留已选择 Team Plan                         | 冷启动前保存结构化 Team Plan selection，账号凭据可恢复                          | 启动 App 并打开模型设置                                                  | Team Plan 仍为当前连接，organization/project identity 完整；OAuth 恢复不覆盖为个人 Coding Plan                                                                 |
| CTP-11 | quota 致命失败后保留来源并可恢复                           | 已登录 BigModel，当前连接为个人 Coding Plan，mock 首次返回 quota fatal          | 打开使用统计 → Coding Plan；确认错误后切到 App Usage，再切回 Coding Plan | 错误态使用当前“无法读取用量统计”语义；subscription snapshot 存在时 Coding Plan 来源 tab 不消失；mock 恢复后重新进入来源并显示 quota、model usage 和 tool usage |

## Fixture Contract

### CTP-12：供应商长团队名称与体验套餐切换（formal）

- Setup：真实 Electron 应用、隔离测试配置，业务 mock 提供长组织名称、个人/团队套餐与一份有效 Start Plan 权益。
- Action：从设置进入模型供应商，选择团队；在宽、窄窗口检查名称与箭头，悬停体验套餐按钮，再点击切换；离开并重新进入设置。
- Assertions：宽屏可显示全称且标题与操作区同行；窄屏不足时名称省略、控件不越界；不显示独立 Switch to；tooltip 使用当前语言的“切换至体验套餐”；实际 setting.json 保存 Start selectedKey，重新进入仍显示 Start Plan。
- 仅覆盖桌面真实应用路径；20 组组件浏览器测试继续承担尺寸/语言/主题组合，不声称覆盖手机 `/remote` 链路。
- 自动化：`packages/desktop/test/e2e/provider-family-responsive.test.ts`。2026-09-04 本地真实 Electron 运行通过，用户确认通过即转正；正式入口不带 manual-review 开关已再次通过（1 passed）。
- 本用例通过 scenario 控制端启用专属长名称和 billing/balance fixture；普通 Team mock 场景恢复默认数据，不发送模型请求。

正式运行命令（本用例不调用模型，账户接口使用本地业务 mock）：

```bash
pnpm --filter @zcode/desktop test:e2e -- --spec './test/e2e/provider-family-responsive.test.ts'
```

通过证据：`packages/desktop/.e2e-artifacts/desktop-e2e-20260904060418619-p33484-6650d642259f46f0/summary.json`（1 passed）。本次修正 runner 的专属 JWT 初始化、等待真实刷新结束，以及 Radix 可见 tooltip 的 WebDriver 选择器；未改产品实现。

转正证据：`packages/desktop/.e2e-artifacts/desktop-e2e-20260904060754282-p39563-0c1b2374a55285ca/summary.json`（1 passed，默认正式入口）。重新进入设置只读取恢复状态，不再次点击供应商导航覆盖选中项。通用转正脚本仅支持 conversation 目录，本用例按设置领域路径迁移并同步引用；没有加入 Docker suite。

窗口取 1800/480px（Electron 最小宽度 480px），tooltip 在 1200px 检查。每次运行保存宽屏、窄屏、tooltip 和重新进入后的 Start 选中截图，以及几何数值和业务请求断言。

### 通用约束

- 本组 case 不生成 DeepSeek provider replay fixture，因为测试不发送模型请求。
- 每次 mock scenario 重启前显式把 `lastWorkspaceSession` 固定到隔离 HOME 的 `ZCodeProject`；不能继承上一条 case 留下的 conversation workspace，否则 workspace 就绪断言和 model-resolution seed 会落到不同 bucket。
- WDIO mock server 负责业务接口：
  - `/api/biz/subscription/enterprise/v2/pricing`
  - `/api/biz/customer/getCustomerInfo`
  - `/api/monitor/usage/quota/limit`
  - `/api/monitor/usage/model-usage`
  - `/api/monitor/usage/tool-usage`
- `type=2` 表示 Team Plan；无 `type=2` 表示个人 Coding Plan。
- mock server 提供 `/__e2e/coding-plan/scenario` 和 `/__e2e/coding-plan/requests` 供 spec 切换场景与断言请求。

## Runner Preflight Contract

- 直接执行 `wdio run wdio.conf.ts` 时也必须校验 Electron package 的 `path.txt` 以及它指向的真实可执行文件，不能只因 `node_modules/.bin/electron` 包装脚本存在就认为 Electron 已安装。
- WDIO config 必须先按优先级加载 desktop/repo 的 `.env.e2e.local`，再读取 Electron 安装配置并执行二进制预检，保证 `ELECTRON_MIRROR`、代理、证书和缓存目录等本地配置同时传给安装子进程与后续 E2E 进程。
- Electron package 存在但二进制缺失时，WDIO config 在创建 ChromeDriver session 前运行该 package 的 `install.js`，随后重新校验真实可执行文件。安装必须有界等待：`ZCODE_E2E_ELECTRON_INSTALL_TIMEOUT_MS` 可覆盖默认 5 分钟超时，超时后必须终止子进程。
- 安装失败、超时或安装脚本执行后仍无二进制时必须直接报告 Electron 安装根因，诊断包含生效超时、脱敏后的镜像地址并通过 `cause` 保留原始异常，不能继续运行并退化成笼统的 `Chrome instance exited`。
- 该预检只修复本机 E2E 依赖，不改变桌面端 `desktop-continuous` session、手机端 `web-remote-replayable` 恢复链路或产品运行时状态。

### CTP-11 权益与额度分离回归（2026-09-17）

同一用例在 1200px 与 390px 分别使用 personalOnly 和 teamOnly：订阅接口有效，quota 先业务失败再传输失败，套餐用量入口仍可进入；恢复 quota 后各自额度重新显示。团队 mock 使用 querySubscribeDetail 返回成员授权；不再用 quota 或个人 subscription/list 合成团队权益。手机 UI 由共用组件回归覆盖逻辑，真实 /remote 验证单列，不由桌面通过推断。

### CTP-13 Start balance 限流恢复（2026-09-17）

Start Plan 的 balance 返回 429 时保留 Start 标题、单一失败提示和重试动作，不提示重新登录。
切换 mock 为有效 balance 后点击重试，套餐展示恢复。共享请求的一秒边界、账号隔离和失效竞态由 `zaiStartPlanBalanceSharing.test.ts` 覆盖。

### CTP-14–19：权益展示补全（formal，2026-09-18）

沿用已确认产品语义，不扩展套餐业务。专属本地 HTTP 夹具由 WDIO server 持有；case 在旧 Electron 完整退出后写入隔离凭据与连接选择，再启动应用读取接口。无需模型 replay fixture（不发送模型请求）。

| Case   | Setup / Action                                                                         | 必须断言                                                                                                                                                          |
| ------ | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CTP-14 | BigModel 未连接，打开编程套餐                                                          | 连接动作、个人和团队购买 banner；无体验购买 banner、无模型列表/添加模型                                                                                           |
| CTP-15 | 个人无权益，团队商品仍 subscribed 但团队已过期                                         | 个人和团队购买 banner 同时出现；无模型列表；个人订阅请求使用 API key                                                                                              |
| CTP-16 | 选择团队，分别已过期、未分配、接口失败                                                 | 对应状态文案；确认过期/未分配时无模型列表（查询失败不等于无权益）；登录态不退化为连接按钮；失败点击重试后有效权益恢复模型列表；团队请求使用业务 token 和组织/项目 |
| CTP-17 | Start 返回 status=active、旧 server_time、已过期 ends_at 和旧余额                      | 以 HTTP Date 判过期；显示过期状态，无今日余额/旧模型列表                                                                                                          |
| CTP-18 | Start 同时返回已过期和有效计划                                                         | 仅有效计划与余额显示，模型列表可用                                                                                                                                |
| CTP-19 | 有效 Start + 已选择并确认可用的个人或团队连接，打开独立 Start 导航（保留付费连接身份） | 有效 Start 无升级/150% 操作；再以过期 Start 验证无个人/团队购买 banner；无付费权益作为正对照时升级可见                                                            |

组合按差异裁剪：CTP-16 覆盖三个独立团队状态；CTP-19 覆盖个人、团队及无权益。中英文品牌命名沿用 PN-01/02，额度失败保留入口沿用 CTP-11 的个人/团队和宽/窄屏组合；一秒共享请求与异步失效由服务单测验证。桌面窄窗口不等同真实手机 `/remote`，后者不在本次桌面回放证据内。这 9 个 case 已经用户确认，于 2026-09-18 迁移到 settings 正式目录；Docker/CI 准入单独验证。

回放发现并修复：Start 页曾直接使用团队导航的 `status=purchased` 判断已有付费权益，而该值可以来自历史 `pricing.subscribed`。现在购买/升级入口只读取 `ProviderSettingsView` 中同平台付费 Provider 的 Account `availability=available` 且 `entitled=true`。目录仅负责发现商品和团队身份。对应组件单测交叉覆盖导航状态与 Account 权益，旧实现出现 2 个失败，修复后通过。

```text
订阅接口 → Account owner 确认权益 → ProviderSettingsView → Start 购买/升级入口
商品目录 → 团队导航身份（不作为权益证据）
```

自动化入口：[coding-plan-entitlement-presentation.test.ts](../../packages/desktop/test/e2e/settings/coding-plan-entitlement-presentation.test.ts)。业务数据由 [entitlement-presentation.ts](../../packages/desktop/test/e2e/fixtures/entitlement-presentation.ts) 提供，含有效静态个人/团队目录、`subscribed=true` 的实时团队商品、体验套餐预览及 150% 活动，避免对缺失配置做空的“不显示”断言。

现有用例维护：CTP-10 / QR 共用的 Account 模型选择更新到本轮 Builtin catalog 的 GLM-5.3；隔离账号首次启动使用共享 `skipOccupationOnboardingIfPresent` 完成引导。原来的 Escape 只临时关闭引导，QR-09/10 重载后会重新遮挡 Composer；失败时的 DOM 证据明确为 `onboarding-page`，不是权益或额度接口失败。

### 本轮验证证据（2026-09-17）

按 `file + title` 取最后一次结果，34 个独立 E2E 全部通过：新增 9 个展示场景，现有 CTP 19 个与 QR 6 个。中间失败及修复回放保留原始报告，不把失败批次写成全绿。

| Run（`packages/desktop/.e2e-artifacts/`） | 结果与覆盖                                                                                             |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `desktop-e2e-20260917-153050-019`         | 28 项中 26 通过。现有 CTP-10 暴露旧模型 ID；新增团队正向夹具需保留付费连接身份。两项已在后续回放修复。 |
| `desktop-e2e-20260917-154234-621`         | 新增 spec 9/9 通过；CTP-10 和 QR-01/02/03/04 通过。QR-09/10 暴露重载后引导遮挡，留待下一批修复验证。   |
| `desktop-e2e-20260917-155127-532`         | 8/8 通过：CTP-02、CTP-10、CTP-11 个人/团队 × 1200/390px，以及 QR-09/10。                               |

12 个相关服务/UI 单测文件共 349 项通过；`pnpm typecheck`、desktop `typecheck:e2e`、`pnpm lint`、`pnpm architecture:check --changed`、改动文件格式与 diff 检查通过。lint 保留基线 55 warnings / 0 errors。应用经过重新构建后回放。

验证环境是 macOS Electron + 本地业务 HTTP mock。未验证生产服务、Windows/Linux、真实手机 `/remote`；上述回放时尚未转正，也未做 Docker/CI 准入。

#### 正式转正验证（2026-09-18）

用户确认转正后，将 9 个展示用例迁移到 `settings/coding-plan-entitlement-presentation.test.ts` 并修正 helper/fixture 引用。通用转正脚本 dry run 只接受 conversation-session 路径，因此沿用 CTP-12 的设置领域迁移方式；业务 HTTP mock 注册按 spec 文件名匹配，无需变更。没有模型请求，无需 DeepSeek replay fixture。

关闭 manual-review 开关，通过正式 WDIO 入口回放，9/9 全部通过，证据为 `packages/desktop/.e2e-artifacts/desktop-e2e-20260917-161817-410/summary.json`。根 typecheck、desktop typecheck:e2e、lint（基线 55 warnings / 0 errors）、架构检查均通过。此次仅转正这 9 个用例，不包含导航语言用例，也未做 Docker/CI 准入。

CTP-16 启动夹具保存旧商品 ID，订阅和 pricing 返回当前商品 ID；组织与项目保持一致。各状态及重试恢复后断言不显示“连接不可用”，覆盖团队商品变更的导航恢复回归。平台/组织/项目隔离由导航单测覆盖。

2026-09-18 商品 ID 变化回归：原生 macOS Electron 回放 CTP-16 三种状态全部通过（3/3），包含失败后重试恢复。证据目录：`packages/desktop/.e2e-artifacts/desktop-e2e-20260918-042734-046/`。导航及可见性相关单测 243/243 通过；未回放真实手机 `/remote`，未使用 Docker。
