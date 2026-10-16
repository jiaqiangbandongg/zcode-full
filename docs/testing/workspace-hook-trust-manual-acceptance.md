# Workspace Hook Trust — 人工验收

> 当前口径：Workspace Hook 只有“未信任 / 持久信任”两种授权结果。普通工具权限的
> `Allow once` 与本功能无关。

## 1. 验收目标

- 未信任的 workspace Hook 默认不执行，也不阻塞正常对话。
- `设置 → 钩子 → 工作区` 中，未信任行只在最右侧配置开关左边显示一个“信任”按钮。
- 点击成功后按钮消失；不显示“配置已启用 / 已信任 / 需要审核 / 将会运行”等状态徽章。
- 配置开关只控制是否启用，信任按钮只建立 exact persistent Trust。
- 已跳过的 SessionStart 不在当前 task 的下一条消息补跑。
- 关闭设置、超时或断连不建立 Trust；声明 digest 变化后重新显示“信任”。

## 2. 准备与启动

在仓库根目录使用 Node 24：

```bash
nvm use 24
pnpm --dir apps/zcode-cli/packages/cli build:desktop-agent
node scripts/create-workspace-hook-trust-uat-fixture.mjs
```

最后一条命令会输出一个新的临时 workspace，例如：

```text
/private/tmp/zcode-workspace-hook-trust-uat-XXXXXX
```

记录该路径，并启动 Desktop：

```bash
pnpm dev:desktop:test
```

fixture 包含两个 SessionStart Hook 和一个 UserPromptSubmit Hook。真实执行只会向下面的
文件追加 JSON，不会执行危险操作：

```text
<workspace>/.workspace-hook-trust-uat/executions.jsonl
```

每轮开始前可校验 fixture 未漂移：

```bash
node scripts/create-workspace-hook-trust-uat-fixture.mjs --verify "<workspace>"
```

## 3. UAT-01：默认拒绝与行内入口

1. 在 Desktop 添加该 workspace，创建新 task，发送 `reply with ok`。
2. 确认对话正常完成，聊天区域出现 Workspace Hook 待审核提示。
3. 点击提示进入 `设置 → 钩子 → 工作区`。
4. 检查每条未信任 Hook。

预期：

- execution marker 不存在，或没有本次 Hook 的记录。
- 每条未信任行的最右侧顺序为 `信任` → `配置开关`。
- 页面没有独立审核面板，也没有批量 Trust/Allow once/Keep blocked 操作。
- 页面没有“配置已启用 / 已信任 / 需要审核 / 将会运行”等徽章。

## 4. UAT-02：关闭状态也可信任

1. 关闭其中一条 Hook 的配置开关。
2. 确认该行仍显示“信任”。
3. 点击“信任”。

预期：

- 成功后该行“信任”按钮消失。
- 配置开关保持关闭，信任动作不会顺带启用 Hook。
- 其他未信任行仍显示自己的“信任”按钮。

## 5. UAT-03：逐行信任与未来事件

1. 对一个 SessionStart Hook 点击“信任”。
2. 留在当前 task，再发送一条 prompt。
3. 对 UserPromptSubmit Hook 点击“信任”，再发送一条 prompt。
4. 创建新 task，让新的自然 SessionStart 发生。

查看执行证据：

```bash
test -f "<workspace>/.workspace-hook-trust-uat/executions.jsonl" \
  && tail -n 20 "<workspace>/.workspace-hook-trust-uat/executions.jsonl"
```

预期：

- 当前 task 中先前被跳过的 SessionStart 不会因信任而补跑。
- 已信任的 UserPromptSubmit 可在下一次自然提交 prompt 时运行。
- 已信任且已启用的 SessionStart 可在新 task/session 的自然 SessionStart 时运行。
- 每次行内信任只影响该行；其他未信任按钮不会一起消失。

## 6. UAT-04：持久化与 digest 变化

1. 关闭并重启 Desktop，再打开同一 workspace。
2. 确认未变声明仍不显示“信任”，且已启用 Hook 可在自然事件运行。
3. 修改其中一条 Hook 的命令参数或 matcher，保存配置并重新进入当前 workspace。

预期：

- 重启不清除 persistent Trust。
- 语义变化的声明生成新 digest，重新显示“信任”并保持 fail closed。
- 未变化声明继续命中原 Trust。

## 7. UAT-05：无决定退出

1. 使用一个新的 fixture 触发待审核状态。
2. 打开设置后直接关闭设置页，不点击“信任”。
3. 可选：等待审核绑定超时，或用手机 Web 断开再连接。
4. 重新进入 Hooks 设置。

预期：

- 关闭、超时、断连都不产生 Trust record。
- 未信任行仍显示“信任”，Hook 仍不会运行。
- mobile replayable 恢复只恢复当前权威状态，不制造临时授权。

## 8. 失败反馈

记录以下信息：

- 本分支 commit SHA、操作系统、Desktop/Web 入口；
- workspace 路径与具体 Hook 行；
- 实际按钮/开关状态；
- `executions.jsonl` 内容；
- `~/.zcode/cli/log` 中对应 session 的日志片段（不要附敏感命令内容）。

自动化验证范围见
[`workspace-hook-trust-persistent-only.md`](../specs/workspace-hook-trust-persistent-only.md)。
