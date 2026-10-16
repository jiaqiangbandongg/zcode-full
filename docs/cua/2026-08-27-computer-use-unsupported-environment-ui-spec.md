# Computer Use 不支持环境的设置与插件列表提示

## 背景

Computer Use 依赖桌面端本机 Helper 访问当前机器的屏幕与输入设备。SSH、WSL、Docker、远端 Server 以及 Linux 桌面当前没有可用的 CUA Helper。过去设置页用 `return null` 隐藏了整块内容，导致远端设置页白屏；插件页只读取目标环境的运行时插件目录，远端目录没有 CUA 时用户也看不到能力入口。

## 目标

- 在远端 workspace 或 Linux 桌面打开设置时，显示 Computer Use 设置入口与明确的“不支持当前环境”说明，不再出现空白页。
- 在同样的目标环境打开插件列表时，展示 CUA 的只读占位项和不可用原因。
- 不向 SSH、WSL、Docker、Server 或 Linux 目标发送 CUA 启用、禁用、安装、卸载、更新请求。
- 保持 macOS/Windows 本地现有开关、macOS 权限流程和手机 Web 远控行为不变。

## 能力边界

```text
目标环境                         Computer Use
本地 macOS                       支持：开关 + macOS 权限
本地 Windows                     支持：开关
本地 Linux                       不支持：提示，不提供操作控件
远端 SSH / WSL / Docker / Server 不支持：提示，不提供操作控件
手机 Web 远控                    沿用 Web 能力灰度，不启动本机 CUA Helper
```

## UI 行为

1. 设置页仍由灰度开关控制是否展示 Computer Use 导航项。灰度开启时，Linux 桌面也展示该入口。
2. 不支持环境的设置页显示一个信息卡，说明 Computer Use 暂不支持 SSH、Linux 等当前环境；隐藏插件总开关、输入框入口开关和权限操作。
3. 插件列表在用户 scope 中增加“电脑控制”只读行，显示“当前环境不可用”徽标和原因；该行不计入已安装/内置数量，不打开详情，也不显示启停、更新、卸载操作。
4. 插件搜索按“电脑控制”“Computer Use”“zcode-cua”“cua”匹配该提示行。

## 数据与实现约束

- 使用统一的 UI 能力判定函数区分本地 macOS、Windows、Linux 与远端目标，远端身份继续通过 `workspaceIdentity` / `remoteTarget` 判定。
- CUA 占位项是 UI 投影，不伪造远端插件运行时数据，也不修改插件协议或远端 Host 能力。
- 该变更只调整设置与插件列表展示，不改变桌面 `continuous` 或手机 `replayable` 实时链路。

## 验收

- 远端 SSH、WSL、Docker、Server 和本地 Linux 的设置页不白屏，能看到不支持说明。
- 上述环境插件列表能搜索并看到“电脑控制”只读行，点击/切换不会触发插件管理写操作。
- macOS/Windows 本地现有单测保持通过；新增能力矩阵、Linux 入口和不支持提示测试。
