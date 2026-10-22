# 真实 Team 模型验证的本机前置未就绪

Status: needs-info

## 当前记录

- 业务基线 `a13999a28927f629d0c64080a5096cf8b4f23bae`，production 构建。
- case `conversation-session-r3-live-bigmodel-team.test.ts`，批次
  `r3-server-20261009234650716-227ddc`，任务 `live-team`。
- 真实登录材料及 Team 连接选择已导入隔离 HOME；当前 OAuth 合同不复制旧账号 API Key。
- 在连接 SSH 之前先核验本机模型菜单，未出现该 case 选择的
  `account:bigmodel-team-coding-plan / GLM-5.3-Flash`。
  case 明确返回 `BLOCKED_ACCOUNT 本机真实账号的 Team 模型未就绪`。
- `live-team.json` 的 `localAccountModelUnavailable=true` 记录此控制组失败。
  本轮没有完成真实 Team 模型请求，不能将它归因为 SSH 回归，也不能用回放替代。

## 待补前置

需核验当前真实账号/项目的模型可用性与指定模型是否仍适用，再运行同一真实请求 case。
本轮真实 API Key 代表 `live-zapi` 已通过；Personal 模型同步、默认值及离线补齐另有通过证据。
