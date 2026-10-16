# Todo 105：精简个人／团队 Account Provider 预设模型名单

> 状态：实现、配置/Registry 验证及逐项复审完成。2026-09-10。实施/测试证据、逐条边界复审及真实环境限制见 [本批交付复审](./provider-todos-105-113-delivery-review.md)。

## 已确认要求

- 个人和团队 Account Provider 的预设模型名单移除 `GLM-5-Turbo`、`GLM-5.2`。
- 范围覆盖 BigModel 与 Z.ai 的个人／团队 Account Provider。

## 范围边界

- 本项只调整上述 Provider 的预设成员，不扩大为删除通用模型能力规则。
- 不顺带调整 Start Plan、Off-Peak 或普通 API Key Provider 的名单。
- 不清理用户自行添加的模型，不改写历史会话、任务等保存的 Model Selection。

## 待执行

- [x] 定位上述 Provider 的预设名单来源，移除这两个型号。
- [x] 更新名单测试，检查其余预设模型和范围外 Provider 不受影响。
- [x] 复审设置页与模型选择列表的结果；实现、验证完成后再关闭本项。

## 实施证据

- 仅改四个个人／团队 `builtinModelIds`，未删除任何模型能力/覆盖规则或改动 Start/Off-Peak 模板名单。
- `account-model-membership.test.ts` 对四 Provider 验证预设精简，同时显式 Personal 添加 5.2/Turbo 仍进入 Registry。修复前名单断言失败，修复后通过；Builtin 完整性 14 条通过。
- 文档维护清单同步。历史/任务/用户配置没有写入或迁移；设置与选择器共用解析名单，不新增 UI 过滤。
