# Conversation Session Decision Backfill Plan

目标：把 answers 草稿中已经填齐的产品结论转换成回写清单。这里不自动修改 catalog/coverage，只列出下一步该回写的事实。

answers 输入：`docs/testing/conversation-session-decision-answers.md`

生成命令：

```bash
node scripts/audit-conversation-session-case-coverage.mjs --check --backfill-plan-md
```

## 当前状态

| 指标 | 当前值 |
| --- | ---: |
| Answered questions | 0 |
| Pending placeholders | 36 |
| Missing question rows | 0 |
| Ready-to-backfill cases | 0 |
| Placeholder-only cases | 36 |
| Partial cases | 0 |
| Missing cases | 0 |

## Ready To Backfill

No ready-to-backfill cases yet. Fill all questions for a case in `conversation-session-decision-answers.md` first.

## Incomplete Cases

| Case | Status | Answered | Pending placeholder | Missing | Next action |
| --- | --- | ---: | ---: | ---: | --- |
| N01 | placeholder-only | 0/1 | 1 | 0 | 填写 N01.1 |
| N02 | placeholder-only | 0/1 | 1 | 0 | 填写 N02.1 |
| N03 | placeholder-only | 0/1 | 1 | 0 | 填写 N03.1 |
| N04 | placeholder-only | 0/1 | 1 | 0 | 填写 N04.1 |
| N06 | placeholder-only | 0/1 | 1 | 0 | 填写 N06.1 |
| N07 | placeholder-only | 0/1 | 1 | 0 | 填写 N07.1 |
| N08 | placeholder-only | 0/1 | 1 | 0 | 填写 N08.1 |
| N09 | placeholder-only | 0/1 | 1 | 0 | 填写 N09.1 |
| S01 | placeholder-only | 0/1 | 1 | 0 | 填写 S01.1 |
| S02 | placeholder-only | 0/1 | 1 | 0 | 填写 S02.1 |
| S03 | placeholder-only | 0/1 | 1 | 0 | 填写 S03.1 |
| S04 | placeholder-only | 0/1 | 1 | 0 | 填写 S04.1 |
| S05 | placeholder-only | 0/1 | 1 | 0 | 填写 S05.1 |
| S06 | placeholder-only | 0/1 | 1 | 0 | 填写 S06.1 |
| S07 | placeholder-only | 0/1 | 1 | 0 | 填写 S07.1 |
| D01 | placeholder-only | 0/1 | 1 | 0 | 填写 D01.1 |
| D02 | placeholder-only | 0/1 | 1 | 0 | 填写 D02.1 |
| D03 | placeholder-only | 0/1 | 1 | 0 | 填写 D03.1 |
| D04 | placeholder-only | 0/1 | 1 | 0 | 填写 D04.1 |
| D05 | placeholder-only | 0/1 | 1 | 0 | 填写 D05.1 |
| L01 | placeholder-only | 0/1 | 1 | 0 | 填写 L01.1 |
| L02 | placeholder-only | 0/1 | 1 | 0 | 填写 L02.1 |
| L03 | placeholder-only | 0/1 | 1 | 0 | 填写 L03.1 |
| L04 | placeholder-only | 0/1 | 1 | 0 | 填写 L04.1 |
| L05 | placeholder-only | 0/1 | 1 | 0 | 填写 L05.1 |
| L06 | placeholder-only | 0/1 | 1 | 0 | 填写 L06.1 |
| L07 | placeholder-only | 0/1 | 1 | 0 | 填写 L07.1 |
| L08 | placeholder-only | 0/1 | 1 | 0 | 填写 L08.1 |
| W01 | placeholder-only | 0/1 | 1 | 0 | 填写 W01.1 |
| W02 | placeholder-only | 0/1 | 1 | 0 | 填写 W02.1 |
| W03 | placeholder-only | 0/1 | 1 | 0 | 填写 W03.1 |
| W04 | placeholder-only | 0/1 | 1 | 0 | 填写 W04.1 |
| W05 | placeholder-only | 0/1 | 1 | 0 | 填写 W05.1 |
| X01 | placeholder-only | 0/1 | 1 | 0 | 填写 X01.1 |
| X02 | placeholder-only | 0/1 | 1 | 0 | 填写 X02.1 |
| X03 | placeholder-only | 0/1 | 1 | 0 | 填写 X03.1 |

## Missing Cases

none
