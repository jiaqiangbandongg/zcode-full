# staging cc580ba72a 合并记录

## 基线与范围

- 本地合并前：`cf6777b82d`，分支 `provider-schema-refinement-20260910`，工作区干净。
- 本次 fetch 固定 staging：`cc580ba72a`，共 17 个上游提交（9 个非 merge 提交），增量涉及 49 个文件。
- 正常 `merge --no-ff` 保留双方提交，不整文件 ours/theirs，不自动推送；不执行待开发 Todo105–113。

## 功能裁决与冲突

| 上游来源 | 行为与处理 |
| --- | --- |
| `758fc8568c`、`da708b7d4a`、`8108d4e4db` | 保留 Account 不可用原因分类、shared 严格 schema、两家个人套餐缺 Key 重试。原因属于运行态，Host 为 owner；UI 使用公共结果，不重新查询权益，不把缺 Key 当作 OAuth 失效。 |
| `2e26360bc9` | 保留 BigModel 内嵌官网的既有 zcode JWT 注入补齐，不改登录/鉴权体系。 |
| `0fedd3c4a2` | 保留 Adapter 的同服务 Coding Plan 历史身份回放兼容；只影响请求局部的 thinking 投影，不映射当前选择、不改历史身份。 |
| `0aa4cc61ae` | 保留 Runtime 的 PDF 端口透传；不恢复旧模型连接接口。 |
| `f5a802f929` | 保留分享组件默认值及回调引用稳定化，Session 归属不变。 |
| `7ef23cfad3`、`12cddd0f87` | 保留 pre-push 不强制 mise 与飞书通知服务改造，验证仍走原门禁；不发送真实通知、不调整外部 CI 凭据。 |

显式冲突仅在 `steps/steps.md`：保留双方新增记录。上游 Todo105 与本分支模型精简 Todo105 重号，将上游账号状态记录改为 Todo114，更新引用；历史 T105 用例及证据路径不改。

隐式交集：上游 `runtime-reasoning-provider-replay.test.ts` 调用 Todo109 已删除的 `migrateLegacyModelSelection`，首次 16 个用例均报 TypeError。按本分支正式 migration 裁决修测试：临时空库播种旧格式，冷重开执行 0020；断言迁移保留所有旧成员和 reasoning parts，后续两轮请求不改写迁移后的历史行。没有恢复旧运行接口，也没有放宽思考内容断言。

## 验证与复审

- App/共享配置/账号/通知/数据库：11 文件、361 测试通过。
- 分享组件：4 文件、48 测试通过。
- CLI Adapter/Runtime/PDF/会话 migration/回滚读取：修正上述测试后 6 文件、101 测试通过。
- 合计 21 文件、510 测试通过；根 `pnpm typecheck`、Agent adapters/core 各自 `tsc --noEmit` 通过。
- `pnpm lint`：0 error / 41 warning；架构检查 0 violation / 0 baseline / 0 new；修改测试格式检查与 diff 空白检查通过。
- 上游新增行为逐组有保留去向；本分支 migration、历史原值保护、正常读取不再补迁、请求局部兼容、Account 事实同步等边界未恢复旧实现。自动合并的 design 文档保留双方条款。
- 使用 architecture-governance 与 React best-practices 复审；模块当前均 unmanaged，无新增 owner 或新跨层 IO。
- 本次不重跑 Pro、完整 Electron、真实手机/SSH 或官方模型网络验签；沿用上游已记录的组件浏览器证据，不把它计入本次 510 条，也不宣称全端全量回归通过。

## 交付

形成双亲 merge 提交，staging 全部提交进入当前分支；仅额外修正合并测试接线和文档编号/记录。不推送远端，不改真实用户数据。
