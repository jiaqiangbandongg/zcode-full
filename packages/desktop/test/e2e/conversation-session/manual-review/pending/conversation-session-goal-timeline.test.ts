import {
  TID_CHAT_ASSISTANT_MESSAGE,
  TID_CHAT_GOAL_VERIFICATION_MARKER,
  TID_CHAT_MESSAGES,
  TID_CHAT_USER_MESSAGE,
} from "@zcode/shared";
import { clearAppData } from "../../../helpers/desktop-app.js";
import {
  clickChatStop,
  prepareConversationE2E,
  countUpstreamRequests,
  getChatRootSnapshot,
  sendPrompt,
  waitForAssistantMessageContaining,
  waitForChatState,
  waitForComposerText,
  waitForUpstreamRequest,
  waitForUserMessageContaining,
} from "../../../helpers/conversation-session.js";

const GOAL_MARKER_PREFIX = "E2E_GOAL_TIMELINE_REPRO";
const GOAL_A_MARKER = `${GOAL_MARKER_PREFIX}_A`;
const GOAL_B_MARKER = `${GOAL_MARKER_PREFIX}_B`;
const FIRST_REPLY = "人类灭绝后，机器哭了。";
const FINAL_REPLY = "人类灭绝之后，机器哭了。";
const SECOND_TARGET_REPLY = "这需要长篇连载，无法一次交付十万字。";
interface GoalTimelineExpectation {
  label: string;
  texts: readonly string[];
}

const FIRST_TARGET_TIMELINE_STEPS = [
  {
    label: "iteration-1-incomplete",
    texts: [
      "第 1 次迭代 · 目标未完成，任务继续",
      "Iteration 1 · Goal incomplete, continuing",
    ],
  },
  {
    label: "iteration-2-complete",
    texts: [
      "第 2 次迭代 · 目标已完成，任务结束",
      "Iteration 2 · Goal complete, ending task",
    ],
  },
] as const satisfies readonly GoalTimelineExpectation[];

const NEW_TARGET_TIMELINE_STEP = {
  label: "new-target-iteration-1",
  texts: [
    "第 1 次迭代 · 目标校验中",
    "Iteration 1 · Verifying goal",
    "第 1 次迭代 · 目标未完成，任务继续",
    "Iteration 1 · Goal incomplete, continuing",
  ],
} as const satisfies GoalTimelineExpectation;

const EXPECTED_TIMELINE_STEPS = [
  ...FIRST_TARGET_TIMELINE_STEPS,
  {
    ...NEW_TARGET_TIMELINE_STEP,
  },
] as const satisfies readonly GoalTimelineExpectation[];

interface ConversationEntrySnapshot {
  id: string | null;
  kind: "assistant" | "goalTimeline" | "user";
  text: string;
  title: string | null;
}

describe("会话区 Goal Timeline E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("同 target 自动续跑与新 target 的 verifier timeline 不应串成同一轮序列", async function () {
    this.timeout(180000);

    await prepareConversationE2E();

    const objective = `${GOAL_A_MARKER}: 写一篇恰好 10 个汉字的科幻小说。不要调用工具。`;
    await sendPrompt(`/goal ${objective}`);
    await waitForComposerText("", "goal timeline: /goal 发送后输入框没有清空");
    await waitForUserMessageContaining(objective);

    await waitForUpstreamRequest(
      {
        excludes: [FINAL_REPLY],
        includes: [GOAL_A_MARKER, "Verify whether the active session goal"],
      },
      "goal timeline: 没有捕获到第 1 次 verifier 请求",
      90000,
    );
    await waitForAssistantMessageContaining(FIRST_REPLY);

    await waitForUpstreamRequest(
      {
        includes: [
          GOAL_A_MARKER,
          FINAL_REPLY,
          "Verify whether the active session goal",
        ],
      },
      "goal timeline: 没有捕获到第 2 次 verifier 请求",
      120000,
    );
    await waitForAssistantMessageContaining(FINAL_REPLY);
    await waitForChatState(
      (snapshot) =>
        snapshot.state !== "streaming" &&
        snapshot.queueCount === 0 &&
        snapshot.targetObjective?.includes(GOAL_A_MARKER) === true &&
        (snapshot.targetStatus === "complete" ||
          snapshot.targetStatus === "completed"),
      "goal timeline: 第一个目标最终没有回到完成态",
      120000,
    );
    // 修复原因：targetStatus 已完成可能早于 synthetic timeline divider 完成渲染；
    // 先等第一个 target 的两条 divider 落 DOM，再切新 target，避免测试制造排序 race。
    await waitForGoalTimelineTexts(FIRST_TARGET_TIMELINE_STEPS);

    const secondTargetObjective = `${GOAL_B_MARKER}: 写一篇 10w 字科幻小说。不要调用工具。`;
    await sendPrompt(`/goal ${secondTargetObjective}`);
    await waitForComposerText(
      "",
      "goal timeline: 第二个 /goal 发送后输入框没有清空",
    );
    await waitForUserMessageContaining(secondTargetObjective);
    await waitForAssistantMessageContaining(SECOND_TARGET_REPLY);
    await waitForUpstreamRequest(
      {
        includes: [
          GOAL_B_MARKER,
          SECOND_TARGET_REPLY,
          "Verify whether the active session goal",
        ],
      },
      "goal timeline: 没有捕获到新 target 的第 3 次 verifier 请求",
      120000,
    );
    const entries = await waitForGoalTimelineTexts(EXPECTED_TIMELINE_STEPS);
    await stopIfStreaming();

    // 修复原因：新 target 的第 1 次 verifier 返回未完成后，产品可能在测试 stop
    // 之前已经启动下一轮合法自动续跑；本 case 只验证前三个 timeline 的归属和顺序。
    expect(
      await countUpstreamRequests({
        includes: [
          GOAL_MARKER_PREFIX,
          "Verify whether the active session goal",
        ],
      }),
    ).toBeGreaterThanOrEqual(3);

    const timelineTexts = entries
      .filter((entry) => entry.kind === "goalTimeline")
      .map((entry) => normalizeEntryText(entry.text));

    expect(
      resolveGoalTimelineSteps(timelineTexts, EXPECTED_TIMELINE_STEPS),
    ).toEqual(
      EXPECTED_TIMELINE_STEPS.map((step) => step.label),
    );

    const firstAssistantIndex = findEntryIndex(
      entries,
      "assistant",
      FIRST_REPLY,
    );
    const firstTimelineIndex = findEntryIndex(
      entries,
      "goalTimeline",
      EXPECTED_TIMELINE_STEPS[0],
    );
    const finalTimelineIndex = findEntryIndex(
      entries,
      "goalTimeline",
      EXPECTED_TIMELINE_STEPS[1],
    );
    const secondTargetUserIndex = findEntryIndex(
      entries,
      "user",
      secondTargetObjective,
    );
    const secondTargetTimelineIndex = findEntryIndexFrom(
      entries,
      "goalTimeline",
      NEW_TARGET_TIMELINE_STEP,
      finalTimelineIndex + 1,
    );

    const orderSnapshot = {
      entries,
      firstAssistantIndex,
      firstTimelineIndex,
      finalTimelineIndex,
      secondTargetUserIndex,
      secondTargetTimelineIndex,
    };
    if (
      firstAssistantIndex < 0 ||
      firstTimelineIndex < 0 ||
      finalTimelineIndex < 0 ||
      secondTargetUserIndex < 0 ||
      secondTargetTimelineIndex < 0
    ) {
      throw new Error(
        `goal timeline: 缺少预期消息或 timeline: ${JSON.stringify(
          orderSnapshot,
          null,
          2,
        )}`,
      );
    }
    expect(firstAssistantIndex).toBeLessThan(firstTimelineIndex);
    expect(firstTimelineIndex).toBeLessThan(finalTimelineIndex);
    // Bugfix: first target complete 后 synthetic divider 可能晚于第二个 /goal user
    // 进入 DOM；本 case 只要求同 target 内部顺序正确，且新 target timeline 不串到旧 target 前。
    expect(secondTargetUserIndex).toBeLessThan(secondTargetTimelineIndex);
    expect(finalTimelineIndex).toBeLessThan(secondTargetTimelineIndex);
  });
});

async function stopIfStreaming() {
  const snapshot = await getChatRootSnapshot();
  if (snapshot.state !== "streaming" && snapshot.runtimeStatus !== "streaming") {
    return;
  }

  // 修复原因：新 target 的第 1 次 verifier 合法返回 failed 后，产品会继续自动
  // 迭代；本 case 只验证前 3 个 timeline 的归属和顺序，收尾时主动 stop，避免
  // 后续长目标续跑把测试拖成 fixture 完整性用例。
  await clickChatStop();
  await waitForChatState(
    (latest) =>
      latest.state !== "streaming" && latest.runtimeStatus !== "streaming",
    "goal timeline: 收尾 stop 后没有退出 streaming",
    30000,
  );
}

async function waitForGoalTimelineTexts(
  expectedSteps: readonly GoalTimelineExpectation[],
) {
  let entries: ConversationEntrySnapshot[] = [];
  let timelineTexts: string[] = [];
  let timelineSteps: Array<string | null> = [];
  await browser.waitUntil(
    async () => {
      entries = await getConversationEntrySnapshot();
      timelineTexts = entries
        .filter((entry) => entry.kind === "goalTimeline")
        .map((entry) => normalizeEntryText(entry.text));
      timelineSteps = resolveGoalTimelineSteps(timelineTexts, expectedSteps);
      // 修复原因：CI 和本地可能使用不同 locale，timeline 文案会在中英文间切换。
      // 这里锁定 verifier 轮次/完成语义，而不是固定某一种语言的展示文案。
      return expectedSteps.every(
        (step, index) => timelineSteps[index] === step.label,
      );
    },
    {
      timeout: 30000,
      timeoutMsg: `goal timeline: 没有看到完成后的目标校验序列, expected=${JSON.stringify(
        expectedSteps.map((step) => step.label),
      )}, actual=${JSON.stringify(timelineSteps)}, texts=${JSON.stringify(
        timelineTexts,
      )}, entries=${JSON.stringify(entries)}`,
    },
  );
  return entries;
}

function getConversationEntrySnapshot(): Promise<ConversationEntrySnapshot[]> {
  return browser.execute(
    (messagesTestId, userPrefix, assistantPrefix, goalVerificationPrefix) => {
      const root = document.querySelector<HTMLElement>(
        `[data-testid="${messagesTestId}"]`,
      );
      if (!root) return [];

      const candidates = Array.from(
        root.querySelectorAll<HTMLElement>(
          [
            `[data-testid^="${userPrefix}-"]`,
            `[data-testid^="${assistantPrefix}-"]`,
            `[data-testid^="${goalVerificationPrefix}-"]`,
          ].join(","),
        ),
      );

      const entries: ConversationEntrySnapshot[] = [];
      for (const element of candidates) {
        const text = (element.innerText || element.textContent || "")
          .replace(/\u00a0/g, " ")
          .trim();
        if (!text) continue;
        if (element.matches(`[data-testid^="${userPrefix}-"]`)) {
          entries.push({
            id: element.getAttribute("data-message-id"),
            kind: "user",
            text,
            title: element.getAttribute("title"),
          });
          continue;
        }
        if (element.matches(`[data-testid^="${assistantPrefix}-"]`)) {
          entries.push({
            id: element.getAttribute("data-message-id"),
            kind: "assistant",
            text,
            title: element.getAttribute("title"),
          });
          continue;
        }
        if (element.matches(`[data-testid^="${goalVerificationPrefix}-"]`)) {
          entries.push({
            id: element.getAttribute("data-message-id"),
            kind: "goalTimeline",
            text,
            title: element.getAttribute("title"),
          });
        }
      }
      return entries;
    },
    TID_CHAT_MESSAGES,
    TID_CHAT_USER_MESSAGE,
    TID_CHAT_ASSISTANT_MESSAGE,
    TID_CHAT_GOAL_VERIFICATION_MARKER,
  );
}

function normalizeEntryText(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

function normalizeGoalTimelineText(text: string) {
  const normalized = normalizeEntryText(text);
  const match = EXPECTED_TIMELINE_STEPS.find((step) =>
    matchesGoalTimelineText(normalized, step),
  );
  return match?.label ?? null;
}

function resolveGoalTimelineSteps(
  timelineTexts: readonly string[],
  expectedSteps: readonly GoalTimelineExpectation[],
) {
  return expectedSteps.map((step, index) =>
    matchesGoalTimelineText(timelineTexts[index] ?? "", step)
      ? step.label
      : normalizeGoalTimelineText(timelineTexts[index] ?? ""),
  );
}

function matchesGoalTimelineText(
  text: string,
  expected: GoalTimelineExpectation,
) {
  const normalized = normalizeEntryText(text);
  return expected.texts.includes(normalized);
}

function findEntryIndex(
  entries: readonly ConversationEntrySnapshot[],
  kind: ConversationEntrySnapshot["kind"],
  text: string | GoalTimelineExpectation,
) {
  return findEntryIndexFrom(entries, kind, text, 0);
}

function findEntryIndexFrom(
  entries: readonly ConversationEntrySnapshot[],
  kind: ConversationEntrySnapshot["kind"],
  text: string | GoalTimelineExpectation,
  fromIndex: number,
) {
  return entries.findIndex(
    (entry, index) =>
      index >= fromIndex &&
      entry.kind === kind &&
      entryMatchesText(entry, text),
  );
}

function entryMatchesText(
  entry: ConversationEntrySnapshot,
  text: string | GoalTimelineExpectation,
) {
  if (typeof text === "string") {
    return entry.text.includes(text);
  }

  return matchesGoalTimelineText(entry.text, text);
}
