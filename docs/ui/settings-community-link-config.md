# 用户社群入口配置

> Todo103：本文保留 staging 的既定行为与历史验收记录；历史通过数不计为本次通过。
> 本次整合证据另记在 todo103-staging-integration-ledger.md，未改变 Provider/Selection 边界。

帮助菜单里的“用户社群”入口与平台“问题反馈”统一从当前 endpoint 的
`client/configs.data.configs.feedbackUrl` 读取；内置 `config/default.json` 用作默认值。

## 配置格式

```json
{
  "feedback_url": "https://example.com/feedback",
  "community_urls": {
    "zh-CN": "https://example.com/zh-community",
    "en-US": "https://example.com/en-community"
  }
}
```

## 解析规则

- 当前语言为 `zh-CN`：依次读取远端 `zh-CN`、内置 `zh-CN`
- 当前语言为 `en-US`：依次读取远端 `en-US`、内置 `en-US`
- 当前语言对应的远端与内置入口都没有：UI 不显示“用户社群”入口

不同语言之间不互相回退，避免中文用户进入 Discord 或英文用户进入飞书。

```text
切换语言
   |
   v
点击用户社群
   |
   +--> 远端当前语言 --> 内置当前语言 --> 不显示入口
                              |
                              v
                           打开入口
```

## 当前默认入口

- `zh-CN` 默认入口使用飞书加好友链接：`https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=47ag983c-8fcb-4d6d-814b-5395193a712c&qr_code=true`
- `en-US` 默认入口使用 Discord 邀请链接：`https://discord.gg/z9aBcQXZQ3`

因此，中文界面的用户进入飞书社群，英文界面的用户进入 Discord；对应语言未配置时不显示入口。

## 实现位置

- shared 解析：`packages/shared/src/remoteAppConfig.ts`
- Desktop 平台解析与本地配置回退：`packages/desktop/src/main/desktopCommandHandlers.ts`
- Web 平台解析：`packages/web/src/communityUrl.ts`
- 帮助菜单显示：`packages/ui/src/WorkspaceHelpMenuButton.tsx`

## 2026-09：迁移到 client/configs

新版帮助配置统一读取当前 endpoint 的 `GET /api/v1/client/configs`，携带现有
`app_version` 和 `platform` 参数，严格验证 `code=0` 后读取
`data.configs.feedbackUrl`。包含 `community_urls`、`feedback_url` 和
`feedback_use_external_form`。旧 CDN 文件保留给旧版客户端，内置
`config/default.json` 保留，Desktop 继续随包发布，Web 继续打包导入。

```text
可见性检查 / 点击入口
          |
   平台注入 HTTP 请求（no-store，10 秒超时）
          |
   当前 endpoint + version + platform 内存缓存（1 小时 / 并发合并）
          |
   code=0 → feedbackUrl → 按字段解析
          |
   远端有效值 → 内置同语言默认值 → 隐藏社群 / 不打开无地址表单
```

公共读取器不写磁盘 HTTP cache、localStorage 或数据库。帮助配置是公开请求，不附带
用户鉴权；缓存按完整请求 URL 隔离，失败不缓存。请求期间切换 endpoint 不得把旧结果
写入新 endpoint 的缓存。字段缺失、无效类型、空链接均回退；布尔 false 是有效覆盖值。
桌面原生帮助菜单及命令面板继续按开关选择内置弹窗或外部表单；问号菜单、Windows
自绘菜单直接打开内置表单的行为不变。Web 的平台反馈动作仍打开外部地址。

Web 使用与现有 OAuth / relay 相同的部署 endpoint 配置，不新增远控 RPC、Host 或
Agent，不改变 desktop continuous / web remote replayable 会话链路。

验证：单测覆盖 envelope、字段与语言回退、false 覆盖、HTTP/JSON/超时失败、并发合并、
TTL 和 endpoint 隔离；交互验证覆盖社群外链及平台反馈动作。需执行 typecheck、lint，
保留运行时请求证据。跨系统与手机实机未执行的项目需在交付时注明。

运行时验证：服务端不接受 `platform=web`（HTTP 400 / code 3001）；Web 省略可选
platform，实测正式 endpoint 返回 HTTP 200 / code 0。桌面沿用 platform-arch。

### 本次验证结果

- 公共解析/缓存、Web 解析及桌面配置单测共 36 项通过。
- `pnpm typecheck` 与 `pnpm lint` 通过（lint 仅有仓库既有 warning）。
- macOS Electron HC-01 已通过：运行时 mock 新接口、社群外链、no-store 请求选项、
  false 不打开外部表单、切换 endpoint 后 true 打开指定反馈表单。
- Windows/Linux 与手机浏览器实机未执行；Web 当前通过请求解析单测与真实接口验证。
  跨域自定义 Web endpoint 仍需服务端允许 CORS，否则按约定使用内置默认值。
- 首次 E2E 与 typecheck 并行导致 out/host 产物存在覆盖风险；单独重新构建后 Host 正常。
  交互断言等待实际外链调用，避免把命令派发完成误认为异步动作完成。

### 旧 CDN 链路清理

新版不再导出旧 CDN 地址常量及版本 URL 构造函数；删除对应过时单测。
保留 `remoteAppConfig.ts` 中仍使用的字段解析函数及其测试。
内置 `config/default.json` 内容与 Desktop/Web 打包方式均不变；线上旧 CDN 文件仍供旧版使用。
本次只清理无调用代码和说明，不改变交互；正式 HC-01～HC-05（8 个 case）继续覆盖新链路。
