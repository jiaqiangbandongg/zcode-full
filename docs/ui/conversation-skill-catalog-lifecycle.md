# Composer Skill Catalog 生命周期

> 状态：2026-08-20 已实现并通过单元/协议回归。
> 关联能力：`capability.session-skill-catalog`、`surface.composer-slash-capability-picker`。
> 关联文档：[mention-panel-layout.md](./mention-panel-layout.md)、
> [conversation-session-case-catalog.md](../conversation-session-case-catalog.md) S08。

## Feature Summary

| Field | Value |
| --- | --- |
| Change | Composer 的 Skill 候选从 workspace 级长期快照改为 workspace/session 双 authority 目录 |
| User-visible surfaces | `/` 的 Skills 分组；兼容入口 `$`、`¥`、`￥` |
| Change layer | option-source / persistence / recovery |
| Existing code owners | `useSkills`、`SlashCommandPlugin`、`skillsMentionProvider`、CLI `AgentRuntime` |
| Out of scope | Settings 的 Skill 管理目录；Skill 安装/删除/启停存储；Subagent/command catalog；canonical mention 格式 |

## 产品语义

Skill 管理面和对话候选面是两种不同 authority：

```text
Settings / 安装 / 删除 / 启停
  `-> workspace 管理目录（每次显式刷新都重新扫描磁盘）

Composer 新草稿
  |-> prewarm 尚未就绪：skills/referenceCatalog(sessionId 缺省)
  |    `-> workspace 当前目录
  `-> prewarm P1 就绪：skills/referenceCatalog(sessionId=P1)
       `-> P1 AgentRuntime 初始化时冻结的目录
            `-> 首发提升为正式 Session S1（沿用同一 runtime）

Composer 已有热 Session S1
  `-> skills/referenceCatalog(sessionId=S1)
       `-> S1 runtime 冻结目录（不热加载新增 Skill）

S1 被 cold resume / Agent runtime restart
  `-> 新 runtime 重新扫描磁盘
       `-> UI runtime revision 变化后重新请求 S1 目录
```

因此，“已有对话不更新”限定为同一个 resident runtime 生命周期。CLI cold resume 会重建
runtime 并重新执行 context/Skill discovery，UI 必须随新 runtime authority 重新查询，不能永久复用旧 Promise
或 renderer 缓存。

显式输入一个不在冻结目录中的 Skill 名称是否能被 Agent 动态加载，继续沿用 CLI `Skill` tool 的既有规则；
Picker 只展示当前 authority 声明的候选，不借此扩大或收紧工具执行权限。

## UI Surface Matrix

| User scenario | UI entry | Option source | Display owner | Authority | Mode boundary | Must remain isolated from |
| --- | --- | --- | --- | --- | --- | --- |
| 新建草稿选择 Skill | `/`、`$`/Yen aliases | prewarm 未就绪时无 `sessionId`；就绪后带 `prewarmSessionId` | request-scoped React hook | workspace 当前目录或当前草稿 prewarm runtime 快照 | local/SSH/WSL/Docker 都走目标 workspace Agent；mobile 复用 shared-host | 不能复用上一任务 Session 目录；不能改 Settings state |
| 已有 Session 选择 Skill | 同上 | 同协议带 `sessionId` | request-scoped React hook | Session runtime 冻结目录 | desktop continuous/mobile replayable 只影响交付，不改变目录语义 | 不得因磁盘新增或 Settings 刷新而热加载 |
| runtime restart/cold resume | 同上 | runtime restart 后重发同一 session query | hook runtime revision | 新 runtime 目录 | remote attachment 变化也属于 request identity | 不得展示旧 runtime 迟到结果 |
| Skill 管理 | Settings | `skillsService.list()` | Settings 本地 state | workspace 磁盘 | 使用现有目标 workspace service | 不改成 session 目录，不受 conversation cache 约束 |

## Shared And Divergent Behavior

| Concern | Shared | Deliberately different |
| --- | --- | --- |
| Picker | `/` 与 `$`/Yen aliases 共用同一 Skill catalog 和映射 | `/` 仍与 commands/Subagents 分组；`$` 只展示 Skills |
| Canonical | 仍写入既有 Skill Markdown/canonical text | 目录 authority 变化不改变发送、edit、queue、retry、fork |
| Discovery | workspace 和 session 都由 CLI Skill discovery 规则生成 | workspace 每次查询取当前磁盘；session 读取 runtime 已冻结结果 |
| Recovery | local/remote 都按 request identity 丢弃迟到结果 | desktop continuous 与 mobile replayable 不共享 renderer 缓存 |

## State Owners And Commit Sinks

| State/fact | Draft/display owner | Authoritative owner | Query/commit | Persistence/cache |
| --- | --- | --- | --- | --- |
| workspace Skill catalog | Picker hook | workspace Agent filesystem/config/plugin discovery | prewarm 未就绪时 `skills/referenceCatalog` 无 sessionId | 仅请求态，不持久缓存 |
| Session Skill catalog | Picker hook | `AgentRuntime.skillLoadOutcome` | 正式 `sessionId` 或草稿 `prewarmSessionId` | resident runtime 内冻结；cold resume/新草稿 prewarm 重建 |
| Skill 管理目录 | Settings local state | `ISkillsService` + 文件/config | `skillsService.list/setEnabled/...` | 现有文件与配置 |
| Skill mention | Lexical draft | conversation user input | existing send command | session transcript canonical text |

## Must-Preserve Invariants

- `workspaceKey = workspaceIdentity?.trim() || workspacePath` 只负责 workspace 身份隔离；
  `workspacePath` 继续用于 Skill 文件发现。
- request identity 至少包含 workspaceKey、remoteSessionId、正式 sessionId/prewarmSessionId/draft、
  runtime revision 和请求序号；
  scope 变化首帧清空，旧结果 fail closed。
- Session query 找不到 session 时协议报错，禁止静默回退 workspace authority。
- Settings 刷新、安装、删除和启停只使未提升草稿 runtime 失效，不热更新已有 resident Session。
- `/` 与 `$`/Yen aliases 不维护两份目录；选择结果继续使用既有 canonical Skill mention。
- relay 和 desktop main 不拥有 Skill catalog，只透传目标 workspace Agent 查询；本改动不改变
  `desktop-continuous` / `web-remote-replayable` 的 conversation stream 语义。

## Feature Relationships

| Rank | From | Edge | To | Why inspect it | Evidence |
| --- | --- | --- | --- | --- | --- |
| must-inspect | session Skill catalog | renders-in | `/` 与 `$` Skill Picker | 两个入口必须共用 authority | `SlashCommandPlugin`、`skillsMentionProvider` |
| must-inspect | session Skill catalog | served-by | `skills/referenceCatalog` | 防止 UI/CLI 双重扫描产生目录分叉 | protocol schema/handler/service tests |
| must-inspect | session Skill catalog | state-owned-by | `AgentRuntime.skillLoadOutcome` | 热 Session 冻结的事实源 | core runtime test |
| conditional | session Skill catalog | recovers-via | runtime restart/cold resume | 新 runtime 必须重查，旧结果不得回填 | hook runtime restart test |
| invariant-only | session Skill catalog | constrained-by | workspace/remote delivery boundary | 本地与远程必须命中目标 Agent | workspaceIdentity/remoteSessionId assertions |

## Codegraph Evidence

| Seed | Query | Direct callers/key path | Depth | Interpretation |
| --- | --- | --- | --- | --- |
| `useSkills` | codegraph explore unavailable；focused `rg` fallback | `SlashCommandPlugin`、`useSkillsMentionProvider` | 2 | 当前两个 Picker 入口共用 workspace 级 store |
| `skillLoadOutcome` | focused `rg` fallback | `ensureContextInitialized` 写入，context builder/Skill tool 读取 | 2 | resident runtime 已有天然冻结目录 |
| `usePluginReferenceCatalog` | focused `rg` fallback | Plugin mention provider → Agent protocol | 2 | 已验证的 workspace/session authority 参考实现 |

## Graph Drift And Delta

现有 feature graph 只声明了 slash Skill surface，没有 Session Skill catalog 的 state owner 和 protocol service。
本实现新增 `capability.session-skill-catalog`、`state.session-skill-catalog`、
`service.skill-reference-catalog` 及其与 Composer、conversation runtime、workspace/delivery boundary 的语义边。

## Boundary Decisions And Accepted Cases

| Boundary | Decision | Includes | Excludes/prunes | Source |
| --- | --- | --- | --- | --- |
| 热更新 | resident Session 不更新 | 手动文件新增、Settings 变更后旧 Session 保持目录 | 不做文件 watcher | 用户确认 + CLI context guard |
| 新建任务 | 新草稿创建新 prewarm runtime，并在 ready 前读取 workspace 当前目录 | 手动添加的 `SKILL.md` | 不复用上一任务的 Session/runtime catalog | 用户确认 |
| cold resume | 随新 runtime 重扫 | app/Agent restart、resident eviction 后恢复 | 不永久持久化旧目录 | 当前 CLI resume 实现 |
| 管理面 | 保持 workspace 实时目录 | Settings 全部管理动作 | 不加 session key | 用户确认 |

| Case ID | Setup | Action | Assertions | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| S08-A | 新草稿/prewarm 创建前手动新增 Skill | 打开 `/` 与 `$` | 两个入口均显示新 Skill；prewarm ready 前 authority=workspace，之后为该 prewarm Session | UI + protocol | accepted |
| S08-B | S1 已初始化后新增 Skill | 在 S1 打开 `/`，再新建草稿打开 `/` | S1 不显示；新草稿显示 | UI + runtime/protocol | accepted |
| S08-C | S1 runtime 重启前后磁盘目录变化 | 重启后重新打开 Picker | 丢弃旧结果并显示新 runtime catalog | UI + runtime event | accepted |
| S08-D | remote attachment/session 切换且旧请求迟到 | 切换 scope | 首帧清空；只接收新 workspace/session/runtime 结果 | UI + service params | accepted |
| S08-E | 草稿从无 prewarm 变为 P1 ready | 保持/重新打开 Picker | request key 切到 P1；taskId 仍为 null；只接受 P1 runtime catalog | Composer + hook | accepted |

## Verification

- 正式 Desktop E2E `conversation-session-v4-mention.test.ts` 在真实 workspace 写入临时
  `.zcode/skills/e2e-session-skill-catalog/SKILL.md`：旧 resident Session 的 `/`、`$` 均不出现该
  Skill；点击新建任务后两个入口出现同一个 canonical `skill:` 候选。
- latest passing artifact：`desktop-e2e-20260820-135214-127`。该 VM 代表 desktop local 的 S08-A/B；
  runtime restart、remote attachment、scope 迟到结果与 prewarm key 切换继续由 focused tests 取证，
  不把未执行的远程/重启组合冒充 Desktop E2E。

## Unresolved Questions

无。Subagent 和 command catalog 是否采用同类 Session 生命周期不属于本改动，单独审计。
