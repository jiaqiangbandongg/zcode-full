# Windows CUA 工具调用与应用启动可靠性设计

> 日期：2026-07-29（2026-07-30 修订工具名方案）
>
> 状态：已确认
>
> 范围：Windows 本地 desktop continuous 源码开发链路
>
> 关联仓库：`z-code`、`C:\Users\dev\zcode-cua`

## 1. 运行时证据与根因

失败会话 `sess_4acdf746-a6c2-4518-8ed9-bd9f587a6cea` 和
`sess_f89ac19d-ceb1-4bf5-bcdd-07504d226bb2` 的模型 I/O 与 Agent 日志共同证明：

- 官方 `zcode-cua` MCP 已连接，30 个工具全部注册，Helper 和 plugin-host 都不是本次
  失败根因；
- 当前远端上游基线通过通用 MCP descriptor 生成 provider-visible 规范名称
  `mcp__plugin_zcode-cua_computer-use__*`；请求中注入的名称保留 `zcode-cua` 和
  `computer-use` 两个连字符片段；
- provider/model 返回了未在请求工具集合中声明的
  `mcp__plugin_zcode_cua_computer_use__*`，把两个连字符片段都改成了下划线；
- registry 按精确工具名查找，因此在 permission、hook 和 MCP dispatch 之前返回
  `Tool not found`；
- `e04766f2a9` 后由 Windows 移植增加的 alias 假设规范名称是
  `mcp__computer-use__*`，既不符合当前完整 namespaced descriptor，也没有从生产 runtime
  传入它要求的 authority 集合，因此该分支是未生效的死代码；
- 上游维护者在 `babdbd5e4c` 中曾使用短名称 `mcp__computer-use__*`，但该实现属于后来被
  `9a80589fbd` 明确回滚的 stabilization merge；当前基线是 `0b0a27f92a` 及其后的远端提交，
  本修订不从已回滚提交中单独摘取旧 descriptor 特例；
- `open_application({app:{name:"calc"}})` 已真实启动计算器，但启动器 PID 最终对应的
  可见窗口由 `ApplicationFrameHost.exe` 承载；现有 Windows resolver 只允许 launcher
  完整 executable identity 与 GUI candidate 完全一致，因此安全地拒绝了错误换绑；
- `Microsoft.WindowsCalculator_8wekyb3d8bbwe!App` 是可精确使用的 AUMID，但当前
  Windows system surface 只接受 `name`，尚无 AUMID 原生激活与 HWND 身份证据。

这不是 MCP 连接故障，而是两个独立缺口：

1. provider/model 返回了请求契约之外的工具名，而当前模型响应边界只校验“非空”，没有校验
   “必须是本次请求中声明的精确名称”；
2. Windows packaged app 缺少 AUMID 启动与精确窗口解析分支。

## 2. 目标

1. 以当前远端上游实现为唯一基线：provider-visible 名称继续由通用 descriptor
   生成，当前官方 CUA 名称为 `mcp__plugin_zcode-cua_computer-use__*`。
2. 删除 Windows 移植增加的短名称/下划线 Registry alias；任何未在本次请求工具集合中精确声明的
   名称都不能进入 permission、hook、event、history 或 MCP dispatch。
3. 当且仅当错误名称通过“仅用于诊断的比较”唯一对应某个规范名称时，允许在没有提交任何
   model/tool 可见事件的前提下发起一次纠正重试；重试响应仍必须精确命中请求工具集合。
4. 无法唯一对应、已经越过流式提交边界或第二次仍错误时，按可恢复的非法模型响应 fail closed，
   不做 alias 路由。
5. Windows `open_application` 接受 AUMID，以原生
   `IApplicationActivationManager` 激活 packaged app。
6. 通过窗口的 `PKEY_AppUserModel_ID` 精确解析目标 HWND/PID；无候选或多 PID 候选时
   fail closed。
7. Windows 对少量内置 packaged app 提供大小写不敏感的精确名称别名；第一批只包含
   Calculator 的 `Calculator`、`Windows Calculator`、`calc`、`calc.exe` 和 `计算器`，
   并统一收敛到 `Microsoft.WindowsCalculator_8wekyb3d8bbwe!App` 后再进入同一条
   AUMID 激活与回读链路。
8. 保留现有 Win32 executable name 启动、完整路径校验、prelaunch snapshot、live
   revalidation 和唯一新候选规则。
9. 修正 Windows skill 文案：AUMID 是 packaged app 的启动身份；后续动作优先使用
   `open_application` 返回的 PID，不能把 `ApplicationFrameHost.exe` 当作 AUMID。

## 3. 非目标

- 不把 `computer-use` 的规范名称改成 `computer_use`；
- 不对任意 MCP server 做连字符/下划线全局归一化；
- 不把下划线错误名称直接改写成规范名称后执行；
- 不修改上游维护者在 `packages/ui` 的 CUA renderer、Core result display、当前通用
  MCP descriptor、manifest 或运行时 authority 设计；
- 不按窗口标题、运行中应用显示名、basename、active 状态或枚举顺序猜测应用；内置
  packaged app 名称只允许走代码内显式维护的 exact alias → AUMID 表，未知名称不猜测；
- 不改变 30-tool manifest、MCP schema、macOS 或 Linux 启动语义；
- 不引入 shell、PowerShell、`explorer.exe shell:AppsFolder` 或桌面快捷方式 fallback；
- 不修改 SSH、WSL、Docker、remote workspace、手机 `/remote` 或 replayable 链路；
- 不做安装包、签名、自动更新或发布闭环。

## 4. 方案选择

### 4.1 工具名称

#### 方案 A：保留 Windows 移植的 Registry alias

不采用。现有 alias 建立在短名称 `mcp__computer-use__*` 假设上，无法命中当前远端
`mcp__plugin_zcode-cua_computer-use__*`；生产 runtime 也没有传入它要求的 authority 集合。
即使补齐匹配，Registry 直接 alias 仍会把请求契约外的模型输出变成可执行调用，掩盖
provider/model 契约错误。

#### 方案 B：恢复已回滚的上游短名称 descriptor

不采用。`babdbd5e4c` 的短名称 descriptor 属于 `9a80589fbd` 明确回滚的 stabilization
merge；当前上游基线 `0b0a27f92a` 没有重新引入该特例。只 cherry-pick descriptor
会绕过回滚边界，并让同一远端基线出现两套互相矛盾的命名事实。

#### 方案 C：请求契约精确校验与一次无副作用纠正重试

采用。模型 adapter 在构造请求时已经持有本次精确 `tools[].name` 集合；响应中的每个
tool name 必须与集合成员字节级一致。连字符转下划线比较只用于判断是否存在唯一的纠正候选，
不得改变 tool call、不得查询 Registry、不得形成 permission 或持久化名称。

第一次响应若在任何可见正文、reasoning、tool block 或 provider retry boundary 提交前命中唯一
候选，则中止并清理原物理请求，以一条不持久化的系统纠正指令重新发起一次请求。纠正指令只列出
允许的精确规范名称，不包含工具参数。第二次响应不再享有拼写纠正预算，必须精确命中；否则按
`InvalidModelResponse` 失败。

如果流式响应已经提交了不可重放事件，则不做自动重试，直接失败，避免正文或 tool block 重复。
非流式响应尚未对外提交，可以使用同一条一次性纠正规则。

```text
上游当前 descriptor
    |
    +-- mcp__plugin_zcode-cua_computer-use__list_apps
    |
provider request tools[]（精确名称集合）
    |
model/provider response
    |
    +-- 精确命中 --------------------------> tool event -> permission -> MCP
    |
    +-- 请求外名称
            |
            +-- 唯一拼写候选且尚未提交事件
            |       |
            |       +-- 丢弃本次响应，零 tool 副作用
            |       +-- 临时纠正指令，最多重试一次
            |       +-- 第二次精确命中才允许执行
            |
            +-- 歧义 / 已提交 / 第二次仍错误
                    |
                    +-- InvalidModelResponse，fail closed

上游 UI/result-display 名称比较
    |
    +-- 只处理已经接受的规范 tool event，不参与路由，保持不变
```

### 4.2 Windows packaged app

#### 方案 A：启动后按 name/title/basename 匹配

不采用。窗口标题可本地化、可重复，也可由目标应用控制；`ApplicationFrameHost.exe`
又同时承载多个 packaged app，无法作为 Calculator 的稳定身份。

#### 方案 B：直接接受 launcher PID 或第一个 active candidate

不采用。launcher 可能退出、转交或被复用；active/枚举第一项不能证明它属于本次调用。

#### 方案 C：AUMID 原生激活与 HWND 属性精确查找

采用。native addon 增加两个 Windows-only 内部 ABI：

- `activateApplicationByAumid(aumid)`：调用
  `IApplicationActivationManager::ActivateApplication`；
- `applicationInfoByAumid(aumid)`：枚举可见顶层 HWND，读取
  `PKEY_AppUserModel_ID`，按 AUMID 大小写不敏感精确匹配并按 PID 去重。

已有同 AUMID 的唯一可见应用可以直接返回；否则激活后在有界预算内轮询。0 个候选继续
等待，多个 PID 候选或预算耗尽返回失败。该分支不把 AUMID 与 executable path 混为一谈。

```text
open_application({bundle_id: AUMID})
    |
exact HWND PKEY_AppUserModel_ID lookup
    |
    +-- unique live PID --> optional explicit activation --> return PID
    |
    +-- none/ambiguous
            |
            +-- native IApplicationActivationManager
            |
            +-- bounded poll exact AUMID
                    |
                    +-- unique live PID --> return PID
                    |
                    +-- none/ambiguous --> fail closed

open_application({name: "notepad.exe"})
      |
existing Win32 full-executable identity path remains unchanged
```

#### Calculator 精确名称别名

采用受限的 exact alias 表，而不是启动后猜窗口。`Calculator`、`Windows Calculator`、
`calc`、`calc.exe` 和 `计算器` 在 Windows broker 产生副作用前先规范化为 Calculator
AUMID；之后完全复用方案 C。这样既修复模型把展示名当 executable 的首次失败，也避免
`calc.exe` 已打开窗口后因 launcher executable 与 `ApplicationFrameHost.exe` 不一致而
误报失败。

别名比较只做 trim 与大小写折叠，不做子串、编辑距离、窗口标题搜索或枚举顺序 fallback。
未知名称继续进入普通 Win32 executable 分支并保留原有校验。

## 5. 组件边界

### `z-code`

- MCP descriptor 和 provider-visible contract 保持当前上游 namespaced 连字符名称；
- `registerMcpTools` 不为模型拼写错误设置 alias；
- allow/deny 继续针对规范 descriptor name 判定；
- adapter 以本次 request tools 精确集合校验流式与非流式 tool call；
- 一次性纠正提示只存在于物理重试请求，不写入 conversation history；
- UI renderer 和 Core result display 的上游比较逻辑不参与执行路由并保持不变。

### `zcode-cua`

- `windowsSystemSurface` 负责区分 executable name 与 AUMID；
- Windows broker 在 launch 前负责把受支持的内置 packaged app exact name alias 规范化
  为 AUMID；该表不读取窗口状态，也不改变非 Windows 语义；
- `helperMain` 只把当前进程已经加载的 Windows native ABI 注入 system surface；
- native addon 负责 Windows COM 激活和 HWND property-store 查询；
- backend/resolver 继续负责有界等待、唯一性、live revalidation 和统一结果；
- public MCP schema 不新增 Windows 专用字段，沿用 `app.bundle_id` 承载 AUMID 输入。

## 6. 安全与兼容不变量

- 任何 CUA 或第三方 MCP 都没有连字符/下划线执行 alias；
- 请求契约外名称不能进入 allow/deny、permission、hook、scheduler、event、history 或 MCP；
- 诊断比较出现多个候选时不得猜测，必须失败；
- 纠正重试最多一次，而且只允许发生在尚未提交不可重放事件的 attempt；
- 日志只记录错误名称、唯一候选和请求/trace 标识，不记录 tool input 或凭据；
- AUMID 必须是非空、无控制字符的单个标识；不得拼进 shell 命令；
- exact name alias 只能映射到代码内固定 AUMID；不能根据窗口标题、当前 active app 或
  `ApplicationFrameHost.exe` 推导身份；
- AUMID lookup 只接受精确属性证据；`ApplicationFrameHost.exe` 路径本身不算成功证据；
- Win32 path 分支不降低既有完整路径、snapshot、唯一性与 TOCTOU 防护；
- Windows AUMID 激活可能由操作系统把窗口带到前台；实现不额外发送鼠标键盘或焦点事件，
  也不承诺 macOS `open -g` 等价的后台启动；
- `urls` 与 AUMID 的参数映射本阶段不猜测，组合出现时 fail closed；
- 工具名校验属于共享模型 adapter，desktop continuous、subagent 和 web remote
  replayable 都必须保持同一精确契约；本次不修改 snapshot、queue、owner、lease、
  workspace identity 或 remote transport 语义。

## 7. 测试

### RED：模型工具名精确契约

- 当前上游 descriptor 继续生成
  `mcp__plugin_zcode-cua_computer-use__list_apps`，本次不修改该实现；
- 请求工具集合中的精确名称可正常通过流式与非流式响应校验；
- `mcp__plugin_zcode_cua_computer_use__list_apps` 在 Registry、permission、hook、event、
  history 和 MCP 调用前被拒绝；
- 唯一候选且尚未提交事件时只重试一次，第二次返回精确名称后只执行一次；
- 第二次仍错误、无候选、多个候选或已提交不可重放事件时 fail closed；
- 第三方 MCP 同样精确校验，不获得 CUA 特例或 alias；
- main agent 与 subagent 使用相同校验，desktop continuous 与 web remote replayable
  不增加新的同步状态。

### RED：Windows AUMID

- `windowsSystemSurface` 接受 bundle ID/AUMID 并调用注入的 native activator；
- Calculator 的五个 exact name alias 都进入相同 AUMID 分支，且不会调用 Win32
  `openRunner(["calc"])`；
- 大小写与首尾空白可以规范化；子串、未知名称和其他相似名称不能命中；
- AUMID + URLs、空 AUMID、缺 native activator 都明确失败；
- backend 优先复用 exact AUMID 唯一 live app；
- 新激活后只接受 exact AUMID 唯一 PID；
- 0 个、多 PID、属性读取失败都 fail closed；
- 原有 Win32 full executable identity 测试保持通过；
- compiled addon 导出与 source contract 一致。

## 8. 验收

- 删除 Windows 移植增加的无效 CUA alias、短名称常量用途及对应错误测试；
- 两个仓库的定向测试、`pnpm typecheck`、`pnpm lint` 通过；
- `zcode-cua` Windows native addon 在本机重新构建；
- source desktop 启动后，最新模型请求只声明上游 namespaced 连字符名称；若第一次返回
  下划线错误名称，日志显示一次无副作用纠正重试，最终不再落入 Registry 的
  `Tool not found`；
- 直接 broker smoke 能通过 Calculator AUMID 打开或复用计算器，并用返回 PID 成功读取
  `get_app_state`；
- 清理只终止本轮自启测试进程，不影响用户原有应用；
- 不启动或修改 SSH、WSL、Docker、remote workspace 和手机远控。
