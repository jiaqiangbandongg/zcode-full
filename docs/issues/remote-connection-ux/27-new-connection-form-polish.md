# 27: 新建连接表单排布与配色

Status: done

**Parent:** [#01 — 远程连接交互与视觉体验优化](01-remote-connection-ux-optimization.md)

**Spec:** [远程设备连接 UX 规格 · RDUX-27](../../architecture/remote-device-connection-ux-spec.md#新建连接表单rdux-272026-10-14)

**What to build:** 设置入口「新建连接」和项目/聊天入口「新建 SSH 连接」共用的表单，按 spec 调整头部、类型切换、SSH config 导入、字段排布、粘贴拆分、内联校验、Docker/WSL 提示、配色和页脚。只改 UI 层，不改连接流程、协议和 `useRemoteConnectionForm` 的状态语义。

**Blocked by:** 无。复用 [#17](17-typed-remote-device-addition.md) 的设置入口分类表单。

## Acceptance criteria

- [x] 设置入口不显示步骤条和说明句，标题为「新建连接」，标题下实时预览连接目标；项目/聊天入口保留三步步骤条并在标题旁显示类型标签。
- [x] 类型切换为带图标的分段控件，选中项使用对应类型色；认证方式、Docker 输入方式保持中性。
- [x] 设置入口「从 SSH config 导入」打开可搜索弹层，选中后显示关联标签；× 只解除关联并保留已填值；没有 Host 时禁用；读取失败显示警告且可手填。项目/聊天入口不显示别名入口。
- [x] 主机与端口同一行；用户名独占一行；高级选项无虚线分隔。
- [x] 主机框粘贴 `user@host`、`user@host:port`、`ssh user@host -p N` 自动拆分并显示「已识别」提示；其他内容原样粘贴；粘贴解除别名关联。
- [x] 打开时焦点在主机；导入后焦点到第一个为空的必填字段。
- [x] 校验错误显示在字段下方并关联 `aria-describedby`，焦点到第一个出错字段，页脚无校验文字；编辑连接弹窗复用同一校验函数与内联错误。
- [x] Docker / WSL 删除顶部说明段；Docker 不可用显示警告卡片，无运行容器显示中性提示。
- [x] 设置入口页脚右对齐；项目/聊天入口左返回、右连接。
- [x] 弹窗上边缘固定在视口 10% 处，切换认证方式或类型时上边缘不移动。
- [x] 中英文、深浅主题、1440 / 480px 均完整可见；保留所有既有 testid，新增 `remote-ssh-config-import`、`remote-ssh-config-alias-chip`、`remote-new-connection-preview`。

## Verification

- UI 单测：`parseSshPasteTarget` 表格测试；`collectRemoteFormFieldErrors` 规则；表单头部、类型切换、导入/关联标签、粘贴、焦点、内联校验、两种入口页脚与编辑弹窗。
- 桌面 E2E：更新 `conversation-session-settings-connection-completion`、`conversation-session-ssh-remote-three-screen` 与 `conversation-session-remote-accessibility` 中受影响的断言；case 保持 pending。
- 类型检查、lint、架构门禁、受影响单测。

## Deferred verification

- [ ] Windows 真实 WSL 发现与手动添加。
- [ ] Web／手机远控入口的真实端到端回归。

## Completion evidence (2026-10-14)

- 实现：头部预览与步骤条在 `RemoteConnectionWizardChrome.tsx`；类型切换、导入与页脚在 `RemoteConnectionDialogContent.tsx`；字段排布、分段控件、别名弹层、粘贴拆分与内联错误在 `RemoteConnectionFields.tsx`；校验唯一来源 `collectRemoteFormFieldErrors`、预览 `formatRemoteDraftPreview`、粘贴解析 `parseSshPasteTarget` 在 `lib/remoteConnectionWizard.ts`；类型配色来源 `REMOTE_KIND_PRESENTATION`。编辑连接弹窗删除自有字段校验，改用同一函数。
- 分段控件未选中项用 `focus-visible:bg-hover` 提示键盘焦点：全局样式自 `2bb283f474` 起禁用了 focus outline / box-shadow。`settings-connection-completion` 原 outline 断言在该提交后必然失败，改为断言 `:focus-visible`。
- 验证：`pnpm typecheck`、`pnpm lint`（0 errors）、`pnpm architecture:check --changed`（0 violations）、新增与受影响 UI 单测通过。本地 macOS Desktop + 独占 Linux SSH 容器运行 `conversation-session-settings-connection-completion.test.ts`，2 项全部通过，包括空表单内联校验与焦点、导入关联标签与焦点、头部预览、切换认证方式时上边缘不动、粘贴拆分、Docker 类型色与说明段删除，并截图覆盖中英文、深浅主题、1440 / 480px。
- `conversation-session-ssh-remote-three-screen.test.ts`：导入按钮、首装确认、添加设备通过；之后被 E2E 环境的「登录已过期」弹窗阻塞，未完成离线重连与收起失败段。
- `conversation-session-remote-accessibility.test.ts`：表单键盘段（含分段控件 `:focus-visible`）通过；之后用例仍等待设置入口进入目录屏，与 #16/#17 的设置内完成语义冲突（连接日志显示已 `remote-connected`），属于既有过期断言，本票未改写该用例后半段。新增的「打开即聚焦主机」断言位于后半段，未执行到。
- 根受影响单测（`--base f67f7570ba`）1393/1395 文件通过；`packages/services` 的 3 项套餐 endpoint 断言（`z.ai` vs `z.ai`）在基线 `f67f7570ba` 上同样失败，与本票无关。

## Follow-up fixes (2026-10-14)

`870fc0e012` 审查后修复四处：端口只填空白时构造出 `port: 0`（构造改读与校验相同的 trim 值）；粘贴解析把 `ssh://user@host`、`user:password@host` 拆出错误用户名（用户名排除 `:`、`/`，原样粘贴）；Docker 空下拉固定显示「选择正在运行的容器」（恢复原因文案）；从「修改主机」打开编辑弹窗时校验焦点落在被提示的主机（只聚焦有错误描述的字段）。UI 单测覆盖四项；桌面 E2E 新增 RDUX27-1。
