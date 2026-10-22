# 06 — 手机端设备列表与最近设备直连

**What to build:** 已登录的手机不扫码直接打开 `/remote/v4`（无 `sid`）时：优先自动连接最近一次用过且当前在线的桌面；否则展示当前账号的设备列表，在线设备置顶并按名字排序，离线设备灰显不可点，支持手动刷新与回到前台自动刷新；选中设备后 URL 写回 `sid`/`mid`/`name` 并连接，刷新页面可直接恢复。连接失败页的"选择其他设备"入口生效。

**Blocked by:** 05

**Status:** in-progress

**Parent:** [Web 远控接入 Relay V2：手机登录后连接桌面](./01-relay-v2-login-pairing.md)

## 验收标准

- [x] 文档先行：`relay-v2-pairing.md` 补无 `sid` 时的落点规则（最近设备 → 列表）、列表排序与刷新策略、URL 回写规则；附设备列表页文本线框与文案表（页头与切换账号入口、列表项内容排布、在线标识、离线灰显、空态、刷新按钮落点），**经用户确认后再进入实现**。
- [x] 无 `sid`：读取 localStorage 最近设备 sid，调用设备列表接口确认在线则直接连接；不在线或无记录则渲染设备列表页。
- [x] 设备列表页：进入时拉取一次、手动刷新、`visibilitychange` 回前台再拉，不轮询；在线设备置顶按 `meta.name` 排序，离线设备灰显不可点并显示 `device_mid` 前 8 位；列表为空时有明确提示。页面为连接前独立全屏页，窄屏宽屏同一布局，不进入 `Root`/侧栏 shell，沿用登录页样式与 `zai-dark` 默认主题，zh-CN/en-US 文案齐备。
- [x] 选中设备后 `history.replaceState` 写回 `sid`、`mid`（来自列表 `device_mid`）、`name`，保留原 `app_version`；最近 sid 写入 localStorage；按 sid 键控的既有本地状态继续可用；刷新页面按 05 的有 sid 路径恢复。
- [x] 失败页"选择其他设备"动作进入列表页；`device-not-owned` 页的两个动作均可用。
- [x] 视觉核对：实现后提供设备列表页截图矩阵（在线/离线混合、空列表；窄屏/宽屏 × 深浅主题 × zh-CN/en-US），沿用 05 的 pending 截图用例。
- [x] 测试（前置编排模块 + 假设备接口）：最近设备在线/离线分流、排序规则、三种刷新触发、URL 回写与 localStorage 写入、空列表；列表页组件渲染测试覆盖在线/离线/空三种状态。
- [ ] 测试环境真机验收：无码打开选设备连接、刷新恢复、用另一账号登录时的账号不匹配与切换账号；记录到 `relay-v2-pairing.md` 验收节。
- [x] `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`、受影响单测通过。

## Comments

- 2026-09-19：用户已确认 [配对 spec 的 06 节](../../web-remote-control/relay-v2-pairing.md#手机设备列表与最近设备06) 的线框、双语文案及行为方案，按前置编排、假设备接口和页面渲染接缝完成实现与测试。
- 本地验收：Web 33 文件312项、浏览器41项、版本恢复6组场景通过；设备列表16张截图位于 `.tmp/remote-login-v2-e2e/`，含 `device-matrix.html` / `device-matrix.png` 概览和 `index.html` 原始矩阵索引。typecheck、lint（60条既有 warning / 0 error）、architecture、桌面 E2E typecheck、Web V4 生产构建通过。
- 双轴评审：Standards 的长列表滚动、焦点问题，以及 Spec 的离线背景与按钮圆角问题均已修复并复核；补充 Web Tailwind 扫描声明后，浏览器计算样式验证离线背景实际生效。
- 尚未完成真实手机与测试环境 OAuth/OSS 验收。全量单测18002项通过、3项失败、12项跳过，并有1个退出异常；进程/桌面 transport/退出异常相关测试定向重跑通过，但既有 `feedback-upload-privacy.test.ts` 路径审计仍失败。依根 AGENTS 保持 `in-progress`，保留改动，不自动 commit；未修改这些既有失败的实现或测试。
- 2026-09-22：用户确认离线设备改为显示本手机记住的设备名（不再显示“未命名设备”），spec 06 节新增“本地记住的设备名”小节；原“不缓存历史在线名称”规则反转，对应单测改为断言保留记住的名字、不保留连接。
