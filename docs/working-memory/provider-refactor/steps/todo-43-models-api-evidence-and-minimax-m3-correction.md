# Todo 43：Models API 证据边界与 MiniMax M3 校正

> 状态：完成

## 1. 新发现

Provider Endpoint 可能提供协议级 Models API。它查询的是当前 `Endpoint + API Schema + 访问材料` 可见的
模型，而不是脱离账号的 Base URL：

```text
Endpoint + API Schema + Access
               |
               v
       Models API 实时响应
               |
               +--> Model ID 成员证据
               `--> 接口明确提供的能力元数据
               |
               v
       发布者差异报告与人工审核
               |
               v
          Built-in Release
```

它不直接覆盖运行时 Config，不形成第四层 Overlay。文档示例只证明接口形状，不能代替带当前访问材料的实时
响应；厂商未返回的能力仍由官方文档和内容消费实测证明。

## 2. MiniMax 冲突校正

旧研究错误地依据过时接口概览和 Models API 示例，把 `MiniMax-M3` 当作未被官方直接 Endpoint 证明的候选。
当前中国区官方“模型调用”文档明确声明：

- M3 是最新 M 系列模型；
- 1,000,000 context，支持 Text/Image/Video；
- 中国区 Anthropic Endpoint 为 `https://api.minimaxi.com/anthropic`；
- 中国区 OpenAI Endpoint 为 `https://api.minimaxi.com/v1`；
- 两套兼容调用示例都直接使用 `MiniMax-M3`。

因此 revision 4 必须把 M3 置于 MiniMax `builtinModelIds` 首位并默认启用。M2.7 与 highspeed 仍可作为速度/
成本不同的可用档位继续默认启用；旧 M2.x 保持关闭。

## 3. 测试先行与验收

先修改真实 Built-in 完整性测试，使 revision 3 失败：

- release revision 为 4；
- MiniMax 前三个成员固定为 M3、M2.7、M2.7-highspeed；
- 三者 Exact Rule 均 `enabled=true`；
- M3 在当前 Anthropic Endpoint 解析为 1M、Text/Image/Video。

随后最小修改 Built-in Config 与当前研究报告。验证 Provider/Provider Node 定向测试和 typecheck、根
`pnpm typecheck`、`pnpm lint`、格式检查与 `git diff --check`。

## 4. 实施记录

- Built-in Config 升级到 revision 4，MiniMax 成员首段改为 M3、M2.7、M2.7-highspeed，三者默认启用；
- M3 的既有 1M 与 Text/Image/Video Model Rule 保持不变，新增真实 Config 测试固定其在中国区 Anthropic
  Endpoint 的 Effective Model Config；
- Design 明确 Models API 只作为发布验证、差异报告或用户主动导入证据，不形成 Runtime 第四层 Overlay；
- 旧研究中“M3 未被兼容 Endpoint 证明”的结论已标记并校正，Todo 41 保留历史轨迹但不再作为当前依据；
- Provider Node 47 项、Provider 151 项测试通过，两个包 typecheck、根 typecheck 通过；根 lint 通过并保留
  33 条与本轮无关的既有 warning。
