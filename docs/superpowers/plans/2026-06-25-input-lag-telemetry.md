# 输入框卡顿埋点(perf_ui_input_lag)实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Lexical 聊天输入框上新增 `perf_ui_input_lag` 埋点,把单次输入处理超过阈值的卡顿上报到 ARMS。

**Architecture:** 在 `TextContentPlugin` 的 update listener 内用 `performance.now()` 测「getEditorMarkdown + onChange」同步耗时;排除 IME 组合态(`editor.isComposing()`)与程序化改写(自定义 update tag);超 500ms 且 ≤5000ms 时调 telemetry 层的 `recordInputLag`。telemetry 层与现有 `perf_ui_stream_stall` 同文件同组,判定逻辑抽成纯函数单测。

**Tech Stack:** TypeScript、React、Lexical、vitest、阿里云 RUM(ARMS)自定义事件。

## Global Constraints

- 当前分支 `feat/input-lag-telemetry`,**永远不要直接提交 staging/主干**。
- 埋点属观测链路,**上报失败只 warn,绝不阻断输入主流程**(复用现有 `emit()`)。
- 复用现有分组 `UI_PERF_ARMS_GROUP = "ui_perf"`,不新建 reporter,不改 `Root.tsx`。
- 阈值 `INPUT_LAG_REPORT_THRESHOLD_MS = 500`;哨兵上限 `INPUT_LAG_SANITY_MAX_MS = 5000`。
- 单测命令:`pnpm --filter @zcode/ui exec vitest run test/uiPerfArmsTelemetry.test.ts`。
- 类型检查:`pnpm typecheck`(根目录,含 packages/ui)。
- 不写组件层重型 E2E:Lexical 在 jsdom 下 update 行为不稳;判定逻辑由纯函数测试覆盖。

---

### Task 1: telemetry 层 — 常量、纯函数判定、上报函数

**Files:**
- Modify: `packages/ui/src/lib/uiPerfArmsTelemetry.ts`(在文件末尾、stream stall 段之后追加)
- Test: `packages/ui/test/uiPerfArmsTelemetry.test.ts`(新增一个 `describe("input lag", ...)`)

**Interfaces:**
- Consumes: 现有 `emit(payload: ArmsCustomEventPayload)`、`UI_PERF_ARMS_GROUP`、`armsReporter`(模块级,已由 `setUiPerfArmsReporter` 注入)。
- Produces:
  - `INPUT_LAG_REPORT_THRESHOLD_MS: number`(= 500)
  - `INPUT_LAG_SANITY_MAX_MS: number`(= 5000)
  - `UI_PERF_EVENT_INPUT_LAG: string`(= `"perf_ui_input_lag"`)
  - `shouldReportInputLag(args: { lagMs: number; isProgrammatic: boolean; isComposing: boolean }): boolean`
  - `recordInputLag(params: { lagMs: number; textLength: number; isProgrammatic: boolean; isComposing: boolean; taskId?: string }): void`

- [ ] **Step 1: 写失败测试**

在 `packages/ui/test/uiPerfArmsTelemetry.test.ts` 顶部 import 块追加(与现有同源导入合并):

```ts
import {
  INPUT_LAG_REPORT_THRESHOLD_MS,
  INPUT_LAG_SANITY_MAX_MS,
  UI_PERF_EVENT_INPUT_LAG,
  recordInputLag,
  shouldReportInputLag,
} from "@/lib/uiPerfArmsTelemetry.js";
```

在文件末尾的最后一个 `describe(...)` 之后追加:

```ts
describe("input lag - shouldReportInputLag", () => {
  it("低于阈值不上报", () => {
    expect(
      shouldReportInputLag({
        lagMs: INPUT_LAG_REPORT_THRESHOLD_MS,
        isProgrammatic: false,
        isComposing: false,
      }),
    ).toBe(false);
  });

  it("超过阈值上报", () => {
    expect(
      shouldReportInputLag({
        lagMs: INPUT_LAG_REPORT_THRESHOLD_MS + 1,
        isProgrammatic: false,
        isComposing: false,
      }),
    ).toBe(true);
  });

  it("超过哨兵上限不上报", () => {
    expect(
      shouldReportInputLag({
        lagMs: INPUT_LAG_SANITY_MAX_MS + 1,
        isProgrammatic: false,
        isComposing: false,
      }),
    ).toBe(false);
  });

  it("程序化改写即使超阈也不上报", () => {
    expect(
      shouldReportInputLag({
        lagMs: INPUT_LAG_REPORT_THRESHOLD_MS + 1000,
        isProgrammatic: true,
        isComposing: false,
      }),
    ).toBe(false);
  });

  it("IME 组合态即使超阈也不上报", () => {
    expect(
      shouldReportInputLag({
        lagMs: INPUT_LAG_REPORT_THRESHOLD_MS + 1000,
        isProgrammatic: false,
        isComposing: true,
      }),
    ).toBe(false);
  });
});

describe("input lag - recordInputLag", () => {
  it("超阈上报,payload 字段正确", () => {
    const reporter = makeReporter();
    setUiPerfArmsReporter(reporter);
    recordInputLag({
      lagMs: 642.7,
      textLength: 1280,
      isProgrammatic: false,
      isComposing: false,
      taskId: "t1",
    });
    expect(reporter.calls).toHaveLength(1);
    expect(reporter.calls[0]).toMatchObject({
      name: UI_PERF_EVENT_INPUT_LAG,
      group: UI_PERF_ARMS_GROUP,
      value: 643,
      properties: {
        lag_ms: 643,
        text_length: 1280,
        task_id: "t1",
      },
    });
  });

  it("不满足上报条件时静默", () => {
    const reporter = makeReporter();
    setUiPerfArmsReporter(reporter);
    recordInputLag({
      lagMs: 100,
      textLength: 5,
      isProgrammatic: false,
      isComposing: false,
    });
    expect(reporter.calls).toHaveLength(0);
  });

  it("无 reporter 时不抛", () => {
    clearUiPerfArmsReporterForTest();
    expect(() =>
      recordInputLag({
        lagMs: 9999,
        textLength: 10,
        isProgrammatic: false,
        isComposing: false,
      }),
    ).not.toThrow();
  });
});
```

- [ ] **Step 2: 运行测试,确认失败**

Run: `pnpm --filter @zcode/ui exec vitest run test/uiPerfArmsTelemetry.test.ts`
Expected: FAIL —— 报 `shouldReportInputLag`/`recordInputLag`/`UI_PERF_EVENT_INPUT_LAG` 等未导出。

- [ ] **Step 3: 实现 telemetry 层**

在 `packages/ui/src/lib/uiPerfArmsTelemetry.ts` 末尾(`clearStreamStallTracking` 之后)追加:

```ts
// 输入框卡顿:在 Lexical update listener 内测「单次输入处理耗时」(getEditorMarkdown+onChange 同步段)。
// 与 stream_stall(输出侧)区分:此为输入侧。只上报超阈卡点,事件量最小。
export const UI_PERF_EVENT_INPUT_LAG = "perf_ui_input_lag";

// 保守起点:只抓最严重卡顿。可据线上分布往下收紧。
export const INPUT_LAG_REPORT_THRESHOLD_MS = 500;
// 超此值大概率是断点调试/标签页挂起/设备休眠唤醒,丢弃避免污染分布。
export const INPUT_LAG_SANITY_MAX_MS = 5000;

// 判定抽成纯函数便于单测:程序化改写(粘贴/setText/mention/历史回填)与 IME 组合态
// 都不算打字卡顿,即使耗时超阈也跳过。
export function shouldReportInputLag(args: {
  lagMs: number;
  isProgrammatic: boolean;
  isComposing: boolean;
}): boolean {
  if (args.isProgrammatic || args.isComposing) {
    return false;
  }
  return (
    args.lagMs > INPUT_LAG_REPORT_THRESHOLD_MS &&
    args.lagMs <= INPUT_LAG_SANITY_MAX_MS
  );
}

export function recordInputLag(params: {
  lagMs: number;
  textLength: number;
  isProgrammatic: boolean;
  isComposing: boolean;
  taskId?: string;
}): void {
  if (
    !shouldReportInputLag({
      lagMs: params.lagMs,
      isProgrammatic: params.isProgrammatic,
      isComposing: params.isComposing,
    })
  ) {
    return;
  }
  const lagMs = Math.round(params.lagMs);
  emit({
    name: UI_PERF_EVENT_INPUT_LAG,
    group: UI_PERF_ARMS_GROUP,
    value: lagMs,
    properties: {
      lag_ms: lagMs,
      text_length: params.textLength,
      // 草稿态无 taskId,留空与其它 ui_perf 事件口径一致。
      task_id: params.taskId,
    },
  });
}
```

- [ ] **Step 4: 运行测试,确认通过**

Run: `pnpm --filter @zcode/ui exec vitest run test/uiPerfArmsTelemetry.test.ts`
Expected: PASS(新增 8 个 case 全绿,原有 case 不受影响)。

- [ ] **Step 5: 提交**

```bash
git add packages/ui/src/lib/uiPerfArmsTelemetry.ts packages/ui/test/uiPerfArmsTelemetry.test.ts
git commit -m "feat(ui): perf_ui_input_lag 埋点 telemetry 层(判定纯函数+上报)"
```

---

### Task 2: 组件接线 — 给程序化 update 打 tag,在 TextContentPlugin 计时上报

**Files:**
- Modify: `packages/ui/src/LexicalChatInput.tsx`

**Interfaces:**
- Consumes: Task 1 的 `recordInputLag`;Lexical `editor.isComposing()`、update listener 回调的 `tags: Set<string>`、`editor.update(fn, { tag })`。
- Produces: 模块级常量 `PROGRAMMATIC_UPDATE_TAG = "zcode-programmatic"`(仅本文件内用,无外部消费方)。

说明:本任务改动是 Lexical 运行时接线,jsdom 下 update 行为不稳,**不写组件单测**;判定逻辑已由 Task 1 的纯函数测试覆盖。本任务以 `pnpm typecheck` + `oxlint` 作为验证门槛。

- [ ] **Step 1: 新增程序化 update tag 常量**

在 `LexicalChatInput.tsx` 顶部常量区(`const CHINESE_SLASH_ALIAS = "、";` 附近)追加:

```ts
// 程序化改写(setText/mention 插入/历史回填等非用户敲键的 editor.update)统一打此 tag,
// 输入卡顿埋点在 update listener 里见到该 tag 即跳过,避免把批量改写误判为打字卡顿。
const PROGRAMMATIC_UPDATE_TAG = "zcode-programmatic";
```

- [ ] **Step 2: 给所有程序化 editor.update 加 tag**

将以下函数里的 `editor.update(() => { ... })` 调用改为带 tag 形式 `editor.update(() => { ... }, { tag: PROGRAMMATIC_UPDATE_TAG })`。逐个修改这些函数的 `editor.update` 调用:

1. `replaceEditorText`(约 134 行)
2. `replaceEditorWithSkillMention`(约 161 行)
3. `replaceEditorWithSlashCommandMention`(约 189 行)
4. `appendEditorFileMention`(约 216 行)
5. `appendEditorPlainText`(约 247 行)

示例(`replaceEditorText`,其余同样在闭合的 `})` 后补 `, { tag: PROGRAMMATIC_UPDATE_TAG }`):

```ts
function replaceEditorText(editor: LexicalEditor, text: string) {
  editor.update(() => {
    const root = $getRoot();
    root.clear();

    // Lexical getTextContent() 用 \n\n 分隔段落，对称处理防止换行翻倍
    for (const line of text.split("\n\n")) {
      const paragraph = $createParagraphNode();
      if (line) {
        paragraph.append($createTextNode(line));
      }
      root.append(paragraph);
    }

    root.getLastChild()?.selectEnd();
  }, { tag: PROGRAMMATIC_UPDATE_TAG });
}
```

注意:`LeadingChineseSlashAliasPlugin` 里约 696 行那个 `editor.update`(把顿号归一成 `/`)**也是程序化插入**,同样补 tag:

```ts
      editor.update(() => {
        if (!isCollapsedSelectionAtEditorStart()) {
          return;
        }

        const selection = $getSelection();
        if (!$isRangeSelection(selection)) {
          return;
        }

        selection.insertText(STANDARD_SLASH_TRIGGER);
      }, { tag: PROGRAMMATIC_UPDATE_TAG });
```

- [ ] **Step 3: 在 TextContentPlugin 内计时并上报**

将 `TextContentPlugin`(约 397–427 行)替换为下面版本。改动点:`import` 顶部加入 `recordInputLag`;listener 回调内用 `performance.now()` 包住 `getEditorMarkdown + onChange`,读 `tags` 与 `editor.isComposing()`,算出 `lagMs` 后交给 `recordInputLag`。`taskId` 通过新增可选 prop 传入。

先在文件 import 区(`import { logger } ...` 附近)追加:

```ts
import { recordInputLag } from "./lib/uiPerfArmsTelemetry.js";
```

然后替换 `TextContentPlugin`:

```tsx
function TextContentPlugin({
  onChange,
  taskId,
}: {
  onChange?: (text: string) => void;
  taskId?: string | null;
}) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    if (!onChange) {
      return;
    }

    return editor.registerUpdateListener(
      ({ dirtyElements, dirtyLeaves, editorState, prevEditorState, tags }) => {
        if (dirtyElements.size === 0 && dirtyLeaves.size === 0) {
          return;
        }

        // 输入卡顿计时:包住「全量序列化 + onChange 同步重渲染」这段处理热点。
        const startedAt = performance.now();

        const nextText = getEditorMarkdown(editorState);
        const previousText = getEditorMarkdown(prevEditorState);
        if (nextText === previousText) {
          return;
        }

        onChange(nextText);

        const lagMs = performance.now() - startedAt;
        // 程序化改写与 IME 组合态不算打字卡顿(判定在 recordInputLag 内统一短路)。
        recordInputLag({
          lagMs,
          textLength: nextText.length,
          isProgrammatic: tags.has(PROGRAMMATIC_UPDATE_TAG),
          isComposing: editor.isComposing(),
          taskId: taskId ?? undefined,
        });
      },
    );
  }, [editor, onChange, taskId]);

  return null;
}
```

- [ ] **Step 4: 给 TextContentPlugin 传入 taskId**

`LexicalChatInput` 组件已有 `taskId` prop(约 804 行 `taskId: string | null`)。在 JSX 里(约 945 行)把它传给插件:

```tsx
          <TextContentPlugin onChange={onChange} taskId={taskId} />
```

- [ ] **Step 5: 类型检查**

Run: `pnpm typecheck`
Expected: PASS,无新增类型错误。

- [ ] **Step 6: lint**

Run: `pnpm --filter @zcode/ui lint`
Expected: PASS(无新增告警;`editor.update` 第二参对象写法符合 oxlint 规则)。

- [ ] **Step 7: 回归单测**

Run: `pnpm --filter @zcode/ui exec vitest run test/uiPerfArmsTelemetry.test.ts test/lexicalChatInputEnter.test.ts`
Expected: PASS(telemetry 测试 + 已有 Lexical Enter 行为测试均不受影响)。

- [ ] **Step 8: 提交**

```bash
git add packages/ui/src/LexicalChatInput.tsx
git commit -m "feat(ui): 输入框卡顿接线 perf_ui_input_lag(打程序化 tag+计时上报)"
```

---

## Self-Review

**Spec coverage:**
- 事件 `perf_ui_input_lag` + `ui_perf` 组 → Task 1 Step 3。
- 测量点在 `TextContentPlugin` 包住 getEditorMarkdown+onChange → Task 2 Step 3。
- 阈值 500 / 哨兵 5000 → Task 1 常量。
- 只测同步耗时不追 paint → Task 2 Step 3(`performance.now` 首尾,无 rAF)。
- 排除 IME(`editor.isComposing()`)→ Task 2 Step 3 + Task 1 判定。
- 排除程序化改写(update tag)→ Task 2 Step 1/2 + Task 1 判定。
- 失败只 warn → 复用 `emit()`(现有实现,Task 1 直接调用)。
- 字段 value/lag_ms/text_length/task_id → Task 1 Step 3 + 测试断言。
- 不放 model/文本内容/mention 数 → payload 中确无。
- 判定抽纯函数单测 → Task 1。
- 不写组件重型 E2E → Task 2 说明。
- 不改 Root → 两个任务都未触及 `Root.tsx`。

**Placeholder scan:** 无 TBD/TODO;每个代码步骤均给出完整代码。

**Type consistency:** `shouldReportInputLag` / `recordInputLag` 的参数名(`lagMs`/`textLength`/`isProgrammatic`/`isComposing`/`taskId`)在 Task 1 定义、Task 2 调用、测试断言三处一致;事件名常量 `UI_PERF_EVENT_INPUT_LAG` 全程统一;tag 常量 `PROGRAMMATIC_UPDATE_TAG` 在 Task 2 内定义并使用。
