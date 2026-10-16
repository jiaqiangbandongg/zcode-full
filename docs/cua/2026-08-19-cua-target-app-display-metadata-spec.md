# CUA 目标应用展示元数据 Spec

## 目标

CUA 工具卡需要显示实际目标应用图标，但模型不需要、也不保证重复提交
`bundle_id`。目标应用必须由 official CUA runtime 根据本次调用已经验证的
`state_id`、`frame_id`、`app_ref` 或 Helper 响应解析，再通过宿主专用结果元数据投影给
ZCode UI。

该能力只改变展示投影，不改变 30 个 CUA 工具的名称、输入 schema、模型可见结果、
权限、副作用、owner/stale 防护或 delivery-state 语义。

发布时 ZCode 的 catalog pin、official plugin wrapper、plugin manifest 和 official plugin
definition 必须共同对齐到包含本能力的 `zcode-cua@0.5.8`。只更新依赖 SHA 而保留旧
wrapper 版本会让开发态 bundle 可用、正式插件缓存路径却仍落在旧版本，版本一致性检查
必须阻止这种半升级状态。

`open_application(activate=false)` 对已运行应用使用 neutral shortcut 时，也必须通过
Helper `application_info({pid})` 补全权威展示身份；不能因为动作未重新派发就回退到模型
输入中的 bundle id。

## 权威解析与信任边界

```text
model input
  state_id / frame_id / app_ref(pid|bundle_id|name)
        |
        v
official zcode-cua invocation context
  session / frame registry / Helper application_info / capture result
        |
        v
MCP CallToolResult._meta["zcode.cua/target-app-display-v1"]
        |
        v
official CUA authority gate in Core
        |
        v
CuaToolResultDisplay.targetApp -> Desktop platform icon adapter
```

- Renderer 和 Desktop main 禁止按 PID 反查应用。PID 属于执行 CUA 的 Helper/runtime，
  在 remote/shared-host 场景下不能假设与 UI 进程属于同一主机或命名空间。
- Core 只接受已经通过 official CUA authority 校验的 MCP 结果元数据。第三方同名 server
  或 tool 不获得该展示能力。
- 模型输入中的 `bundle_id` 只能作为 Helper 的待验证引用，不能直接成为展示身份。
- 同一次调用首次取得的权威应用身份锁定展示上下文。后续 settle observation 只能补充
  同一应用；身份冲突时不投影目标应用，UI 回退通用 CUA 图标。

## Producer 元数据契约

`zcode-cua` 在统一 tool wrapper 完成后附加：

```ts
type CuaTargetAppDisplayMetaV1 = {
  schemaVersion: 1;
  displayName?: string;
  iconLocators: Array<
    | { kind: "darwin-bundle-id"; value: string }
    | { kind: "windows-executable-path"; value: string }
    | { kind: "windows-aumid"; value: string }
  >;
};
```

- `iconLocators` 按优先级排列，最多三个；身份冲突时可保留首个权威名称但必须清空
  locator，使 UI 使用通用图标。
- macOS 使用 Helper 捕获到的 bundle id。
- Windows 普通应用使用 canonical exe 绝对路径。窗口存在有效 AUMID 时优先使用
  AUMID；`ApplicationFrameHost.exe` 不得作为 AUMID 失败后的图标 locator。
- Linux 本期不产生 locator。
- 全局工具（access、list_apps 卡片、display、cursor、clipboard、wait、stop 和无
  app owner 的全屏截图）不产生 target metadata。
- app-scoped frame 经 `zoom` 生成子 frame 时，必须继承完整的应用身份（名称、PID、
  bundle id、AUMID 和 icon locator），并在 `zoom` 本次结果及后续 coordinate 工具中
  继续投影同一 target metadata；无 app owner 的全局 frame 及其子 frame 必须保持无目标。
- `_meta` 不进入 provider-visible tool result；现有 frame-integrity metadata 必须保留。

## Core、持久化与 UI

- `CuaToolResultDisplayPayload` 保持 `schemaVersion: 1`，新增可选
  `targetApp: { displayName?: string; iconLocators: ApplicationIconLocator[] }`。
  旧记录无需迁移。
- live `tool_call_result` 与 completed tool part metadata 使用同一份 bounded display，
  resume/cold hydration 直接消费持久化字段，不解析模型可见文本。
- Desktop continuous 与 Web Remote replayable 复用同一 V4 row；relay/main 不新增
  task、queue、snapshot 或恢复状态。
- CUA 卡片取图标顺序为 structured `display.targetApp`、旧 input、旧 JSON result、
  通用 CUA 图标。不增加对普通 `app:` 文本行的解析。
- `IPlatformService.getApplicationIcon` 接受结构化 locator request，同时保留 string
  兼容入口。macOS 继续解析 bundle；Windows exe 使用 Electron `app.getFileIcon`，
  AUMID 由 Desktop 通过 Windows Shell `AppsFolder` identity 读取。
- Web、手机和 Linux 无原生 resolver 时返回 `null` 并显示通用图标。

## 失败与安全

- locator 需通过 runtime schema。Darwin bundle、Windows AUMID、Windows absolute exe
  path 分别校验；Windows exe 只允许本机固定盘符绝对路径，UNC、设备路径、相对路径
  及 legacy string 均不得进入 `app.getFileIcon`。非法、过长或非官方来源一律忽略。
- 图标读取失败不改变 tool 成功状态，不向模型回灌错误；Desktop 只记录有界 warn，
  同一 locator 使用缓存避免高频日志和重复 I/O。
- 异步图标结果不得在组件卸载或 locator 已变化后回写。

## 测试

- Producer：PID-only、state_id、frame_id、return_state=none、冲突、并发隔离、全局工具、
  app-scoped/global frame 的 zoom 身份继承、frame-integrity metadata 共存以及模型内容不变。
- Core/contracts：official authority 投影、第三方拒绝、新旧 display schema、持久化/V4
  round-trip。
- UI/Desktop：structured metadata 优先级、legacy fallback、卸载安全、缓存、locator
  校验、macOS bundle、Windows exe 和 AUMID adapter。
- Windows 实机 smoke 覆盖普通 Win32 应用和 Calculator 商店应用；macOS smoke 覆盖
  Calculator。无法在当前主机执行的 Windows native smoke 必须在提交说明中列出。

## 2026-09-17 修订：producer 换键 + node_repl 消费路径

本文上面描述的 `zcode.cua/target-app-display-v1` 已被 producer 在 2026-08-20
（`zcode-cua@2796e8736 feat(cua): own application presentation metadata`）替换为
`zcode.cua/app-associations-v1`：

```ts
type CuaAppAssociationsV1 = {
  schemaVersion: 1;
  /** 单一目标动作与观察（APP_ASSOCIATION_MODE_BY_TOOL 里声明 "primary" 的工具）。 */
  primary?: { appKey: string; displayName?: string; icon?: { mimeType: "image/png"; data: string } };
  /** list_apps（声明 "items"）：按结果下标关联，携带最多 128 条。 */
  items?: Array<{ resultIndex: number; application: /* 同 primary */ unknown }>;
};
```

- `appKey` 取代 `iconLocators`，形态为 `darwin:<bundleId>` / `windows-aumid:<aumid>` /
  `windows-exe:<canonical path>` / `linux-exe:<path>`；locator 由消费侧按前缀派生。
- producer 现在自己携带 Helper 抓到的 ≤32×32 PNG。**ZCode 不投影这个 `icon`**：会话协议
  不承载 data URL 的约定不变，图标仍由 `IPlatformService.getApplicationIcon(locator)` 解析。
- ZCode 侧从未实现过 `target-app-display-v1` 的消费；`CuaToolResultDisplay.targetApp`
  与 `iconLocators` 自 2026-08-20 起就取不到值，工具卡图标一直靠 legacy
  `readBundleId(input) ?? readCuaResultBundleId(result)` 兜底。该兜底只对历史会话保留。

Computer Use 迁到 `node_repl` 之后，「official CUA authority gate in Core」这一跳不再成立
（工具名恒为 `mcp__node_repl__js`，`readCuaToolName` 不匹配）。新链路把可信点前移到宿主：

```text
producer _meta["zcode.cua/app-associations-v1"].primary
      |
      v  broker 响应，沙箱不可见
node-repl-host CUA bridge（唯一可信记录点）
      |
      v  NodeReplRunResult.cuaApp
node_repl 结果 _meta["zcode/nodeReplCuaApp"]（宿主独占写入）
      |
      v
Core `node_repl_images.app` -> UI leading icon
```

- 沙箱可写通道（`nodeRepl.setResponseMeta`、`nodeRepl.emitStructuredResult`）送达的
  `zcode.cua/app-associations-v1` 一律丢弃：这两个 API 挂在模型可见 globals 上，否则模型
  可以让工具卡声称自己操作了别的应用。处置方式与
  `zcode/nodeReplBrowserScreenshotContentIndices` 一致。
- `node_repl` 的 server 身份由宿主生成且最后合并（`resolveAppRuntimeConfig` 保留内建
  identity），用户与第三方无法用同名配置劫持，因此 Core 侧按该 server 名消费宿主键是安全的。
- 完整投影与展示合同见 [`cua-tool-app-identity-summary.md`](cua-tool-app-identity-summary.md)
  的「node_repl 时代的身份来源」。
