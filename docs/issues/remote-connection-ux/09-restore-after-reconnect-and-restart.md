# 09 — 重连或重启后回到原处

Status: done

**父规格：** [远程连接交互与视觉体验优化](./01-remote-connection-ux-optimization.md)

**被阻塞于：** [08 — 断线体验与原地重连](./08-disconnect-experience-and-in-place-reconnect.md)。挂回完成前显示的占位和横幅由 08 提供。

**要交付的行为：**

- **重连后**：回到断开前正在看的会话。如果那个会话已经不存在，就打开该项目的新任务页。
- **重启应用后**：恢复上次激活的项目和会话。
  - 远程项目挂回完成之前，只显示"连接中"的占位。
  - 如果挂回最终是"未连接"或"失败"，就停留在这个页签上并显示横幅，不自动跳到本地项目。
- **影响范围**：这些改动只作用于桌面端的持续恢复（continuous），手机端的可重放恢复（replayable）保持不变。

对应父规格「重连与恢复」一节中的"回到原处"部分和时序图。

范围：

- **恢复目标由谁负责**：复用已有的页签持久化来记录恢复目标，不新增 owner。
- **挂回门禁**：规则不放宽，挂回完成前不渲染任何远端会话内容。
- **动手前**：先核对 [Renderer 挂回门禁文档](../../remote/desktop-remote-session-renderer-reattach.md)，再把时序图、owner 和事件顺序写进 [导航规格](../../remote/project-first-remote-navigation-spec.md)。

验收标准：

- [x] 导航规格已写入时序图、恢复目标的 owner 和事件顺序，并与挂回门禁文档一致。
- [x] 重连后回到原会话；原会话已不存在时，打开该项目的新任务页。需要有页签持久化测试和 E2E 覆盖。
- [x] 重启后恢复上次激活的远程项目和会话；挂回完成前只渲染占位。需要有挂回测试，并覆盖 E2E 的冷启动重连用例。
- [x] 挂回失败时停留在原页签并显示横幅，不会自动跳到本地项目。
- [x] 回归桌面持续恢复和手机可重放两条恢复路径，手机远控的现有测试全部通过。
- [x] 以下检查全部通过后在本地提交：`pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`、受影响的单测、受影响的 E2E。


## 实施与验证记录（2026-09-28）

- 导航恢复继续复用 TabStore 的项目/激活位置与 Layout 既有 pane 选择持久化。冷启动保留原远程焦点；后台补齐与 Source 挂回不抢焦点；原会话已不存在时回到该项目新任务页。
- 恢复查询只在启动恢复或 attachment 挂回边界读取远端权威 task-index；新任务 ACK 早于索引写入，不参与删除判定。RPC 错误保留目标，导航/attachment 换代取消旧查询。重连携带恢复选择意图，普通目录选择保持原语义。
- 页签持久化、同路径身份隔离、pane 恢复、查询取消、手机禁用、新建任务索引竞态回归先红后绿；原有 Renderer readiness 测试验证挂回前不挂载远端数据层。本地规范和规格双线评审的问题已修复并复核通过。
- `pnpm typecheck`、`pnpm lint`（0 错误、64 条既有警告）、`pnpm architecture:check --changed`（0 违规）、E2E 类型检查和两个受影响 fixture 检查通过。
- 真实 SSH 冷启动 E2E PASS：`r3-server-rdux09-cold-20260928-03`，覆盖原地重连、完整 Electron/Main/Host 重启后原 B 会话、关闭自动重连后的原页签横幅与无远端内容占位、失效会话 ID 的新任务回退。
- 混合项目恢复 E2E PASS：`r3-server-rdux09-mixed-20260928-01`，覆盖原远程焦点、active-first 补齐、open set 不丢失/不重复、siblings 独立挂回与原任务续发。
- 手机真实 relay + SSH E2E PASS：`r3-server-rdux09-mobile-20260928-01`，覆盖桌面 continuous 与手机 replayable 联动恢复；测试页面从当前分支源码构建。均使用 macOS Electron → 本机隔离 Linux Docker SSH 目标，手机为 Chrome viewport，未做实体手机或跨机 WAN 验证。
- 首轮 SSH 被线上公告阻挡，按录像证据为这两条导航用例接入既有账号 mock；第二轮首发暴露新任务索引时序问题，已由回归测试和后续真实 SSH PASS 验证修复。全量单测初次与构建并发因内存压力主动中止，最终单独运行，不将中止计为通过。
- E2E 继续保留 manual-review/pending，未进行人工转正或 Docker CI 准入。

- 完整单测最终完整运行：`ZCODE_TEST_POOL=forks pnpm test:unit --maxWorkers=2 --reporter=dot`，2,031 文件 / 18,683 项通过，2 文件 / 14 项按配置跳过，3 文件 / 25 项失败。22 项因布局测试的旧 mock 缺少新读取的 selector/resolver 接口，补齐后 24 项布局断言通过；另 3 项来自未改动的更新器测试（超时及其后调用次数异常）和 256 MiB slow 上传独立进程测试。最终对全部失败文件和本次改动测试串行复测：7 文件 / 217 项全部通过，未修改更新器或上传实现/测试。没有把全量首次退出码描述为通过；后续只改测试替身，没有再次重复全量。
- 必要验证、失败项复测与 diff 自检已完成；按实施约定在当前分支本地提交，不推送。
