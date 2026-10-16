# Conversation Session Decision Answers

目标：收集产品已经确认的 case 结论。审计脚本只识别 `- F09.1 = 明确结论` 这种行；空答案会被统计为 pending placeholder，不会被当成已确认。

使用方式：

1. 从 [conversation-session-next-decision-answer-template.md](./conversation-session-next-decision-answer-template.md) 看下一批需要优先确认的问题。
2. 在本文件对应 `=` 后面改成明确产品结论。
3. 运行 `pnpm audit:conversation-session-coverage`。
4. 审计通过后，再把答案回写到对应 decision worksheet / catalog / coverage matrix。

## 填写规则

- 每个问题都保留固定编号；不要改 `F09.1` 这类编号。
- 还没有产品结论时，保留 `=` 后面为空。
- 如果决定剪枝，仍然要写清楚结论，例如：`不覆盖，原因：...`。
- 结论要能转成 UI / network / runtime / file 的稳定断言。

## P0-1 Compact 故障

已裁决并退役（2026-07-05，v4 重构 M0 决策清收）。`F09.1-4 / G11.1-4 / G12.1-4` 的逐项结论归档在 [compact decision worksheet 的「裁决归档」节](./conversation-session-compact-decision-worksheet.md)；源 catalog / fault catalog / coverage matrix / roadmap 均已回写。本节不再保留 `X.Y =` 行，避免审计脚本把已退役协议题统计成 unknown。

## P0-2 模型/API 请求故障

N01:
- N01.1 =

N02:
- N02.1 =

N03:
- N03.1 =

N04:
- N04.1 =

N06:
- N06.1 =

N07:
- N07.1 =

N08:
- N08.1 =

N09:
- N09.1 =

## P0-3 SSE 流式故障

S01:
- S01.1 =

S02:
- S02.1 =

S03:
- S03.1 =

S04:
- S04.1 =

S05:
- S05.1 =

S06:
- S06.1 =

S07:
- S07.1 =

## P1-1 文件系统/存储故障

D01:
- D01.1 =

D02:
- D02.1 =

D03:
- D03.1 =

D04:
- D04.1 =

D05:
- D05.1 =

## P1-2 App 生命周期/进程故障

L01:
- L01.1 =

L02:
- L02.1 =

L03:
- L03.1 =

L04:
- L04.1 =

L05:
- L05.1 =

L06:
- L06.1 =

L07:
- L07.1 =

L08:
- L08.1 =

## P2-1 Workspace / Tool 外部变化

W01:
- W01.1 =

W02:
- W02.1 =

W03:
- W03.1 =

W04:
- W04.1 =

W05:
- W05.1 =

## P2-2 跨 Session 故障隔离

X01:
- X01.1 =

X02:
- X02.1 =

X03:
- X03.1 =
