# Todo 25：ZAPI 产品入口与专属兼容退役

> 状态：已完成
>
> 日期：2026-08-27
>
> 前置关系：基于 Todo 21 已完成的 ZCode Built-in Config / Registry 权威链；不改变通用 Provider、Model、
> Account Family 或远程工作区模型选择语义。

## 1. 产品裁决

`builtin:zapi` 不再是 ZCode 产品中的 Provider。设置页、模型选择、运行时、Telemetry、当前共享类型、当前文档和测试
不得继续把 ZAPI 表达为可用入口，也不得在目标 Host Registry 缺少它时由 Renderer 静态制造占位 Provider。

删除后的事实链为：

```text
ZCode Built-in Release / Personal Config / Account Overlay
                       |
                       v
              Target Host Registry
                       |
                       v
            Settings / Model Selection

Renderer 不再维护 builtin:zapi 身份或内网可见性门禁。
```

## 2. 删除范围

- 从当前 `BUILTIN_MODEL_PROVIDER_IDS` 与 `BuiltinModelProviderId` 删除 ZAPI；
- 删除设置页静态 ZAPI Preset、空状态、内部可见性 Hook、专属图标/名称/URL 与模型选择展示特判；
- 删除仅服务 ZAPI 的 internal-only gate、Runtime Override、Vite 注入和对应测试；
- 删除 ZAPI Telemetry 标签、Composer family 特判和其他运行时硬编码；
- Desktop 与 CLI Legacy Provider importer 识别历史 `builtin:zapi` 后直接丢弃，不把它迁移为 Personal Provider
  或 Environment Configured Default；随之删除旧 ZAPI Anthropic Endpoint、模型格式和 Reasoning 规范化特例；
- 当前 Design、设置说明和产品文档删除 ZAPI 入口描述；Changelog、历史实施日志和归档计划继续作为历史证据保留；
- 仅把 ZAPI 当任意 Provider ID 使用的测试改用中性测试 ID，避免测试继续暗示产品支持。

通用 `SystemService.probeIntranet`、内网依赖下载地址和 `INTRANET_MACHINE_HOST` 不属于 ZAPI，继续保留。

## 3. 兼容边界

- 不提供 ZAPI alias、隐藏入口、Feature Flag 或重新启用路径；
- Bundled Config 当前没有 ZAPI，不新增 tombstone Provider；
- Remote / Active / LKG Release 如果包含 `builtin:zapi`，整份 Release 视为不兼容并回落到其他兼容候选；
- 旧物理配置中的 ZAPI 在一次性 importer 边界被忽略；其他 Provider 原样迁移；
- 远端 ZCode Built-in Release 应停止下发 ZAPI。客户端不再为缺失的 ZAPI 创建幽灵入口。

## 4. 验收

- 当前源代码、正式配置和非历史文档不再出现 `builtin:zapi` / `ZAPI` 产品入口；
- `isBuiltinModelProviderId("builtin:zapi")` 返回 `false`；
- Settings Preset 列表不包含 ZAPI；
- Legacy Store 同时包含 ZAPI 和普通 Provider 时，仅普通 Provider 被导入；
- Desktop、Web 与 Remote Settings 都只消费目标 Host Registry，不执行 ZAPI 内网探测；
- 定向单测、`pnpm typecheck` 与 `pnpm lint` 通过。

## 5. 实施结果

- 当前 Built-in 身份、Settings Preset、模型选择展示、Telemetry 与 Composer 已删除 ZAPI；
- ZAPI 专属 internal-only gate、Renderer Hook、Runtime Override 与 Vite 注入已删除；
- ZCode Built-in Release 解码拒绝包含退役 ID 的 Remote、Active 或 LKG 候选，避免远端旧配置重新发布 ZAPI；
- Desktop Legacy Store Reader 与 CLI importer 仅保留私有 retired ID，并在任何归一化前直接丢弃旧 ZAPI
  Provider 和默认选择；
- 当前 Provider、内网探测、设置页和模型选择文档已同步，历史日志与 Changelog 不改写；
- Bootstrap 定向测试 39/39 与 ZAPI Legacy 远程权威用例通过；Todo 24 收口后的 CLI
  Provider/Adapter/Bootstrap 合并回归 228/228 通过；
- 根 `pnpm lint` 为 0 error（34 条既有 warning），根 `pnpm typecheck` 通过；
- 根全量 Unit 仅受宿主缺少系统 `zip` 的两个无关 Windows ZIP 用例阻塞；隔离补入兼容命令后对应 17/17 通过；
- 本轮修改文件定向格式检查通过；根 `pnpm fmt:check` 仍被仓库既有二进制文件和 Electron 上游示例 HTML 解析错误阻塞。
