# 每日 E2E 作者统计飞书上报

## 目标与口径

本功能每天把桌面端 E2E 的作者归属统计写入飞书多维表格，供团队查看每日快照和趋势。统计源固定为：

```bash
node .agents/skills/e2e-author-stats/scripts/count-e2e-authors.mjs --json
```

默认范围为 `all`：已追踪的 `packages/desktop/test/e2e/**/*.test.ts`，包含
`conversation-session/manual-review/pending`。每个 `it(...)` / `test(...)` 声明算一条，
包括 `.skip`；作者是首次新增所在 spec 文件的 Git 作者，不是最后修改该 case 的作者。

可通过 `E2E_AUTHOR_STATS_SCOPE=formal` 改为仅统计正式桌面 E2E。统计必须在具有完整 Git
历史的工作区执行；浅克隆会破坏首次新增作者的归属。

## 飞书表结构

脚本默认在 `LARK_E2E_BITABLE_TOKEN` 指向的 Base 中创建或复用 `E2E 作者统计` 数据表。字段为：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| 统计键 | 文本 | `统计日期/范围/作者`，用于幂等更新 |
| 统计日期 | 文本 | `Asia/Shanghai` 日期 |
| 范围 | 文本 | `all` 或 `formal` |
| 作者 | 文本 | Git 作者名称 |
| 用例数 | 数字 | 作者对应的 case 数 |
| 总用例 | 数字 | 当前范围的总 case 数 |
| 可运行用例 | 数字 | 未跳过 case 数 |
| 跳过用例 | 数字 | 跳过 case 数 |
| Spec 文件数 | 数字 | 参与统计的 spec 文件数 |
| 提交 SHA | 文本 | 统计使用的 Git 提交 |
| 作者归属口径 | 文本 | 统计脚本回传的归属说明 |

每日每个作者占一行。相同的 `统计日期 + 范围 + 作者` 再次运行会更新现有行，不会产生重复快照。

## 配置与执行

脚本为 `scripts/ci/push-e2e-author-stats-to-bitable.mjs`，需要以下环境变量：

```text
LARK_E2E_APP_ID
LARK_E2E_APP_SECRET
LARK_E2E_BITABLE_TOKEN
```

`LARK_E2E_AUTHOR_STATS_TABLE_ID` 为可选项；缺省时按表名寻找，不存在则创建。不要复用
`LARK_E2E_TABLE_ID`：它属于运行结果指标表，不是作者统计表。

飞书应用必须拥有目标 Base 的文档管理权限，并开通多维表格的读、写、建表和建字段权限。密钥只能放在
系统密钥链或 CI Secret 中，禁止提交到仓库、文档或自动任务 prompt。

本地验证不会写飞书：

```bash
E2E_AUTHOR_STATS_DRY_RUN=1 node scripts/ci/push-e2e-author-stats-to-bitable.mjs
```

正式运行会自动建表、补齐缺失字段，并批量创建或更新当天作者行。

## 本机定时任务

本机 Agent 定时任务从 macOS Keychain 读取上述三个变量，再执行上报脚本。任务本身不包含密钥；每日
任务应只执行上报，不修改代码、不创建提交。默认使用 `Asia/Shanghai` 的每天上午执行时间，修改频率或
停用任务应通过所用 Agent 的定时任务管理界面完成。

如果任务失败，优先检查：飞书应用是否已被添加为 Base 的文档应用、应用权限是否发布、Keychain 条目是否
存在，以及运行环境是否能解析 `open.feishu.cn`。
