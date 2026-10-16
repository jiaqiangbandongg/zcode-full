# Force Update Client Config

## 背景

ZCode Desktop 需要支持远端按版本拉闸。当远端配置明确下发强制升级要求时，低于最低版本的 Desktop 客户端必须在创建主窗口前阻断使用，并引导用户更新；远端没有下发该配置时，不做本地版本比较，也不改变现有启动流程。

## 配置字段

远端 `GET {activeZCodeEndpointOrigin}/api/v1/client/configs` 的 `data.configs` 可增加：

```json
{
  "forceUpdate": {
    "minimalVersion": "4.0.0"
  }
}
```

Desktop main 启动前守卫读取当前 `ZCODE_ENV` / endpoint override 解析出的 active ZCode endpoint：`pnpm dev:desktop` 默认等同 `dev:desktop:prod`，因此请求正式服务端；测试环境必须显式运行 `pnpm dev:desktop:test`。静态 `https://cdn.zcode-ai.com/zcode/config/default.json` 的同名字段形态仅作为解析兼容，不再作为 Desktop 启动前守卫的固定读取地址。业务服务里的 client config 解析继续复用同一字段语义。

## 判定规则

- 只有 `forceUpdate.minimalVersion` 是非空字符串时才进入比较。
- 未下发 `forceUpdate`，或 `minimalVersion` 缺失、为空、不是合法 semver 时，不触发强制升级。
- 本地版本使用编译期 `ZCODE_VERSION`。
- 使用 semver 语义比较本地版本与 `minimalVersion`；本地版本小于最低版本时判定为需要强制升级。
- 预发布版本遵循 semver 规则：例如 `4.0.0-beta.1` 小于 `4.0.0`。
- 读取远端和本地配置都失败时不拉闸，预留完全离线状态下跳过更新校验进入界面的接口；后续如需显式离线策略，应在 Desktop main 守卫中接入，不下沉到 UI Root。

## 产品行为

- Desktop 需要强制升级时，main 进程在创建主窗口前展示独立小窗口/系统对话框，不打开主界面，不进入工作区或设置页。
- 提示内容只说明当前版本与最低可用版本，避免重复描述。
- Desktop 提供两个升级引导：
  - 自动升级：触发现有自动更新检查/下载流程；如果更新已下载，则直接进入重启安装。
  - 手动升级：打开官网下载页，按应用语言分流到中文或英文页面。
- 用户关闭或处理强制升级提示后，旧客户端不继续进入主界面。
- Web / 手机远控不参与本次强制更新改动；手机端仍保持“项目打开之后才能用”的既有语义，不新增强制更新兜底页或手动升级入口。

## 多端边界

该能力只在 Desktop main 创建主窗口前读取当前 active ZCode endpoint 的 `client/configs` 并阻断启动，不修改 session、task stream、snapshot、queue、owner command 或 replayable/continuous 消息链路。手机 Web 远控仍通过 shared-host attachment 进入既有 Root，本次 Desktop 强制更新逻辑不会把 replayable 恢复语义扩散到桌面 continuous 主链路，也不会改变手机端远控边界。
