import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TID_TOOL_SUMMARY_TRIGGER } from "@zcode/shared";
import { clearAppData, seedSettings } from "../helpers/desktop-app.js";
import { waitForUpstreamRequestContaining } from "../helpers/conversation-session-network.js";
import { waitForToolCallBlockByToolName } from "../helpers/conversation-session-tool.js";
import { expandAssistantHistoriesWithContent } from "../helpers/conversation-session-tool-diagnostics.js";
import {
  ensureToolCrossProductFullAccessMode,
  respondToToolCrossProductBlockers,
} from "../helpers/conversation-session-tool-cross-product.js";
import { resolveE2ERuntimePath } from "../helpers/e2e-runtime-paths.js";
import {
  E2E_REPLY_TOKEN,
  clickV4Stop,
  getV4PaneSnapshot,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "../helpers/v4-conversation.js";

const CASE_MARKER = "E2E_TOOL_DETAIL_TOGGLE_READ";
const TOOL_TURN_TIMEOUT_MS = 150000;
const TOOL_DETAIL_TOGGLE_EPSILON_PX = 2;
const TOOL_DETAIL_RUNTIME_ROOT = resolveE2ERuntimePath(
  "conversation-session-tool-detail-toggle-stability",
);
const TOOL_DETAIL_READ_FILES = [
  join(TOOL_DETAIL_RUNTIME_ROOT, "read-fixture-a.txt"),
  join(TOOL_DETAIL_RUNTIME_ROOT, "read-fixture-b.txt"),
] as const;

interface ToolDetailToggleSample {
  contentDisplay: string;
  contentExists: boolean;
  contentHeight: number;
  contentHidden: boolean;
  expanded: boolean;
  shellHeight: number;
  time: number;
}

interface ToolDetailToggleProbe {
  error?: string;
  samples: ToolDetailToggleSample[];
  targetOpen: boolean;
}

describe("P08 Explore 工具详情折叠稳定性", () => {
  before(async function () {
    this.timeout(TOOL_TURN_TIMEOUT_MS);
    await seedSettings({ messageStreamShowTodos: true });
    await prepareV4ConversationE2E();
  });

  afterEach(async () => {
    await stopIfBusy();
    await cleanupReadFixture();
  });

  after(async () => {
    await cleanupReadFixture();
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("连续两次 Read 聚合 Explore 的详情展开与收起高度连续归零", async function () {
    this.timeout(TOOL_TURN_TIMEOUT_MS);

    await prepareReadFixture();
    await ensureToolCrossProductFullAccessMode();

    const prompt = [
      `${CASE_MARKER}_${Date.now()}:`,
      `Read ${TOOL_DETAIL_READ_FILES[0]} and ${TOOL_DETAIL_READ_FILES[1]}.`,
      `Then reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`,
    ].join(" ");
    await sendV4Prompt(prompt);
    await waitForV4TimelineContaining(CASE_MARKER);
    await waitForUpstreamRequestContaining(CASE_MARKER);
    await waitForToolTurnIdle();
    // 修复原因：正式 v4 replay 可能在下一条 DOM 断言前已完成整轮，工具块此时
    // 已进入折叠历史；先展开完成态历史，再判断 Explore，避免只在慢响应下通过。
    await expandAssistantHistoriesWithContent();

    const block = await waitForToolCallBlockByToolName("Explore", 30000);
    expect(block.exists).toBe(true);
    expect(block.toolName).toBe("Explore");
    await assertExploreToolDetailToggleStability();
  });
});

async function prepareReadFixture(): Promise<void> {
  await cleanupReadFixture();
  await mkdir(TOOL_DETAIL_RUNTIME_ROOT, { recursive: true });
  await Promise.all(
    TOOL_DETAIL_READ_FILES.map((filePath, index) =>
      writeFile(
        filePath,
        [
          `P08_READ_FILE_${index + 1}_CONTENT`,
          "This file is read by the P08 Explore toggle stability e2e.",
          "",
        ].join("\n"),
        "utf-8",
      ),
    ),
  );
}

async function cleanupReadFixture(): Promise<void> {
  await rm(TOOL_DETAIL_RUNTIME_ROOT, { recursive: true, force: true });
}

async function waitForToolTurnIdle(): Promise<void> {
  let latestState = "not-started";
  await browser.waitUntil(
    async () => {
      await respondToToolCrossProductBlockers();
      const snapshot = await getV4PaneSnapshot();
      latestState = JSON.stringify({
        canStop: snapshot.canStop,
        sessionId: snapshot.sessionId,
      });
      return !snapshot.canStop;
    },
    {
      timeout: TOOL_TURN_TIMEOUT_MS,
      timeoutMsg: `P08 Read 工具轮没有结束，latest=${latestState}`,
    },
  );
  await waitForV4AssistantMessageContaining(E2E_REPLY_TOKEN);
}

async function assertExploreToolDetailToggleStability(): Promise<void> {
  await expandAssistantHistoriesWithContent();
  await browser.waitUntil(
    () =>
      browser.execute(
        (summaryTriggerPrefix) =>
          Boolean(document.querySelector(`[data-testid^="${summaryTriggerPrefix}-explore:"]`)),
        TID_TOOL_SUMMARY_TRIGGER,
      ),
    {
      timeout: 10000,
      timeoutMsg: "P08 连续 Read 工具没有聚合为可展开的 Explore 详情",
    },
  );

  const opening = await probeLatestExploreToolDetailToggle(true);
  assertExploreToolDetailToggleProbe(opening);
  const closing = await probeLatestExploreToolDetailToggle(false);
  assertExploreToolDetailToggleProbe(closing);
}

function probeLatestExploreToolDetailToggle(targetOpen: boolean): Promise<ToolDetailToggleProbe> {
  return browser.executeAsync(
    (summaryTriggerPrefix, shouldOpen, done) => {
      const trigger = Array.from(
        document.querySelectorAll<HTMLElement>(`[data-testid^="${summaryTriggerPrefix}-explore:"]`),
      ).at(-1);
      const shell = trigger?.closest<HTMLElement>('[data-slot="collapsible"]');
      if (!trigger || !shell) {
        done({
          error: "explore-toggle-elements-missing",
          samples: [],
          targetOpen: shouldOpen,
        });
        return;
      }

      const readSample = (): ToolDetailToggleSample => {
        const content = Array.from(shell.children).find(
          (child): child is HTMLElement =>
            child instanceof HTMLElement && child.dataset.slot === "collapsible-content",
        );
        const contentStyle = content ? window.getComputedStyle(content) : null;
        return {
          contentDisplay: contentStyle?.display ?? "none",
          contentExists: content !== undefined,
          contentHeight: content?.getBoundingClientRect().height ?? 0,
          contentHidden: content?.hasAttribute("hidden") ?? true,
          expanded: trigger.getAttribute("aria-expanded") === "true",
          shellHeight: shell.getBoundingClientRect().height,
          time: performance.now(),
        };
      };

      const samples = [readSample()];
      if (samples[0]?.expanded === shouldOpen) {
        done({
          error: "explore-toggle-already-at-target",
          samples,
          targetOpen: shouldOpen,
        });
        return;
      }

      trigger.click();
      const startedAt = performance.now();
      const sampleAnimation = () => {
        const current = readSample();
        samples.push(current);
        const elapsed = performance.now() - startedAt;
        const settled = shouldOpen
          ? current.expanded &&
            current.contentExists &&
            !current.contentHidden &&
            current.contentDisplay !== "none" &&
            current.contentHeight > 0
          : !current.expanded &&
            (!current.contentExists || current.contentHidden || current.contentDisplay === "none");
        if (elapsed >= 450 && settled) {
          done({ samples, targetOpen: shouldOpen });
          return;
        }
        if (elapsed >= 1200) {
          done({
            error: "explore-toggle-animation-not-settled",
            samples,
            targetOpen: shouldOpen,
          });
          return;
        }
        requestAnimationFrame(sampleAnimation);
      };
      requestAnimationFrame(sampleAnimation);
    },
    TID_TOOL_SUMMARY_TRIGGER,
    targetOpen,
  ) as Promise<ToolDetailToggleProbe>;
}

function assertExploreToolDetailToggleProbe(probe: ToolDetailToggleProbe): void {
  if (probe.error || probe.samples.length < 10) {
    throw new Error(`P08 Explore 折叠采样不完整: ${JSON.stringify(probe)}`);
  }

  const samples = probe.samples;
  const finalSample = samples.at(-1)!;
  if (finalSample.expanded !== probe.targetOpen) {
    throw new Error(`P08 Explore 折叠终态不正确: ${JSON.stringify(probe)}`);
  }

  const reversals = samples.flatMap((sample, index) => {
    const previous = samples[index - 1];
    if (!previous) return [];
    const reversed = probe.targetOpen
      ? sample.contentHeight + TOOL_DETAIL_TOGGLE_EPSILON_PX < previous.contentHeight
      : sample.contentHeight - TOOL_DETAIL_TOGGLE_EPSILON_PX > previous.contentHeight;
    return reversed
      ? [
          {
            index,
            previous: previous.contentHeight,
            value: sample.contentHeight,
          },
        ]
      : [];
  });
  if (reversals.length > 0) {
    throw new Error(`P08 Explore 折叠高度方向反转: ${JSON.stringify({ reversals, probe })}`);
  }

  if (!probe.targetOpen) {
    const firstHiddenIndex = samples.findIndex(
      (sample, index) =>
        index > 0 &&
        (!sample.contentExists || sample.contentHidden || sample.contentDisplay === "none"),
    );
    const lastVisible = firstHiddenIndex <= 0 ? undefined : samples[firstHiddenIndex - 1];
    const firstHidden = firstHiddenIndex < 0 ? undefined : samples[firstHiddenIndex];
    const finalHeightJump =
      lastVisible === undefined || firstHidden === undefined
        ? Number.POSITIVE_INFINITY
        : Math.abs(firstHidden.shellHeight - lastVisible.shellHeight);
    if (
      lastVisible === undefined ||
      lastVisible.contentHeight > TOOL_DETAIL_TOGGLE_EPSILON_PX ||
      finalHeightJump > TOOL_DETAIL_TOGGLE_EPSILON_PX
    ) {
      throw new Error(
        `P08 Explore 收起仍有尾部间距跳变: ${JSON.stringify({ finalHeightJump, lastVisible, probe })}`,
      );
    }
  }
}

async function stopIfBusy(): Promise<void> {
  const snapshot = await getV4PaneSnapshot();
  if (!snapshot.canStop) {
    return;
  }
  await clickV4Stop();
  await waitForV4Pane(
    (nextSnapshot) => !nextSnapshot.canStop,
    "P08 afterEach stop 后没有退出 streaming",
    30000,
  );
}
