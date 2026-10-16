import {
  TID_AUTOMATIONS_OPEN,
  TID_CHAT_MODEL_SELECT_ITEM,
  TID_CHAT_MODEL_SELECT_TRIGGER,
  TID_OFFPEAK_CARD,
  TID_OFFPEAK_CREATE_BUTTON,
  TID_OFFPEAK_EDIT_SUBMIT,
  TID_OFFPEAK_FORM_INSTRUCTIONS,
  TID_OFFPEAK_FORM_TITLE,
  TID_OFFPEAK_TAB,
  testId,
} from "@zcode/shared";
import {
  clearAppData,
  clickTestIdByDom,
  setInputValueByTestIdDom,
  waitForTestIdByDom,
} from "../../../helpers/desktop-app.js";
import {
  assertUpstreamRequestCapture,
  waitForUpstreamNetworkCapture,
} from "../../../helpers/upstream-capture.js";
import { UPSTREAM_MODEL } from "../../../helpers/upstream-provider.js";
import {
  prepareConversationE2E,
  sendPrompt,
  waitForAssistantMessageContaining,
  waitForChatState,
  waitForComposerText,
  waitForUserMessageContaining,
} from "../../../helpers/conversation-session.js";
import { sel } from "../../../helpers/selectors.js";

const OFFPEAK_PARENT_MARKER = "E2E_OFFPEAK_SUBAGENTS_PARENT";
const ORDINARY_PROMPT_MARKER = "E2E_OFFPEAK_SUBAGENTS_ORDINARY_PROMPT";
const ORDINARY_REPLY_TOKEN = "E2E_OFFPEAK_SUBAGENTS_ORDINARY_OK";
const EXPECTED_FOREGROUND_STAGES = [
  "child-explore",
  "child-general-purpose",
  "child-code-search",
  "child-custom-inherit",
] as const;
const UNEXPECTED_BACKGROUND_STAGES = [
  "unexpected-background-explicit",
  "unexpected-background-profile",
] as const;

interface OffPeakMockRequestRecord {
  hasApiKey: boolean;
  hasAuthorization: boolean;
  hasCodingPlanApiKey: boolean;
  maxTokens?: number;
  model?: string;
  requestJson: unknown;
  stage: string;
  ticketId: string;
}

describe("闲时 turn foreground subagent 模型继承 E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("OP10: 内建/自定义 foreground 覆盖 profile model，background 拒绝且下一轮恢复用户 provider", async function () {
    this.timeout(300000);

    await prepareConversationE2E();

    const title = `E2E_OFFPEAK_SUBAGENTS_${Date.now()}`;
    await createOffPeakTask({
      instructions: `${OFFPEAK_PARENT_MARKER}: verify the foreground subagent provider matrix.`,
      title,
    });

    const records = await waitForOffPeakScenarioCompletion();
    await clickTestIdByDom(TID_AUTOMATIONS_OPEN, {
      timeoutMsg: "闲时任务完成后无法重新打开 Automations",
    });
    await openOffPeakTab();
    await waitForOffPeakCardCompleted(title);

    const parentInitial = requireStage(records, "parent-initial");
    const foregroundRecords = EXPECTED_FOREGROUND_STAGES.map((stage) =>
      requireStage(records, stage),
    );
    const parentContinuation = requireStage(records, "parent-continuation");
    const ticketIds = new Set(
      [parentInitial, ...foregroundRecords, parentContinuation].map((record) => record.ticketId),
    );

    expect(ticketIds.size).toBe(1);
    for (const record of foregroundRecords) {
      expect(record.model).toBe("GLM-5.2");
      expect(record.maxTokens).toBe(parentInitial.maxTokens);
      expect(record.hasApiKey).toBe(true);
      expect(record.hasAuthorization).toBe(true);
      expect(record.hasCodingPlanApiKey).toBe(true);
    }
    for (const stage of UNEXPECTED_BACKGROUND_STAGES) {
      expect(records.some((record) => record.stage === stage)).toBe(false);
    }

    const continuationBody = JSON.stringify(parentContinuation.requestJson);
    expect(continuationBody).toContain(
      "Idle-time tasks do not support background agents. Run this agent in the foreground.",
    );
    expect(continuationBody).toContain("E2E OffPeak Background Reviewer");

    await openOffPeakTaskSession(title);
    await waitForChatState(
      (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
      "闲时任务完成后打开 session 没有回到 idle",
      60000,
    );

    await sendPrompt(ORDINARY_PROMPT_MARKER);
    await waitForComposerText("", "闲时任务后的普通 prompt 没有提交");
    await waitForUserMessageContaining(ORDINARY_PROMPT_MARKER);
    const ordinaryRecord = await waitForUpstreamNetworkCapture(ORDINARY_PROMPT_MARKER);
    assertUpstreamRequestCapture(ordinaryRecord, {
      expectedText: ORDINARY_PROMPT_MARKER,
      model: UPSTREAM_MODEL,
    });
    await waitForAssistantMessageContaining(ORDINARY_REPLY_TOKEN);

    const afterOrdinaryPrompt = await readOffPeakMockRequests();
    expect(
      afterOrdinaryPrompt.some((record) =>
        JSON.stringify(record.requestJson).includes(ORDINARY_PROMPT_MARKER),
      ),
    ).toBe(false);

    // F-OFFPEAK-001/F-OFFPEAK-003/F-OFFPEAK-005：闲时表单只展示隐藏
    // idle-plan 的扁平模型，不把当前 Chat 的 Start/Coding 连接泄漏进来。
    await clickTestIdByDom(TID_AUTOMATIONS_OPEN, {
      timeoutMsg: "普通 prompt 完成后无法打开 Automations",
    });
    await openOffPeakTab();
    await clickTestIdByDom(TID_OFFPEAK_CREATE_BUTTON, {
      timeoutMsg: "闲时任务创建入口没有出现",
    });
    await waitForTestIdByDom(TID_OFFPEAK_FORM_TITLE, {
      timeout: 15000,
      timeoutMsg: "闲时任务创建页没有打开",
    });
    const modelTrigger = $(sel(TID_CHAT_MODEL_SELECT_TRIGGER));
    await modelTrigger.waitForDisplayed({ timeout: 15000 });
    expect(await modelTrigger.getAttribute("data-model-current-value")).toBe("GLM-5.2");
    await modelTrigger.click();
    const visibleModelItems = await browser.execute(
      (itemPrefix) =>
        Array.from(document.querySelectorAll<HTMLElement>("[data-testid]"))
          .map((element) => element.dataset.testid ?? "")
          .filter((value) => value.startsWith(itemPrefix)),
      `${TID_CHAT_MODEL_SELECT_ITEM}-`,
    );
    expect(visibleModelItems).toEqual([testId(TID_CHAT_MODEL_SELECT_ITEM, "GLM-5.2")]);
    await browser.keys("Escape");
  });
});

async function createOffPeakTask(input: { instructions: string; title: string }): Promise<void> {
  await clickTestIdByDom(TID_AUTOMATIONS_OPEN, {
    timeoutMsg: "侧栏没有出现 Automations 入口",
  });
  await clickTestIdByDom(TID_OFFPEAK_CREATE_BUTTON, {
    timeoutMsg: "闲时任务创建按钮没有出现",
  });
  await setInputValueByTestIdDom(TID_OFFPEAK_FORM_TITLE, input.title, {
    timeoutMsg: "闲时任务标题输入没有出现",
  });
  await setInputValueByTestIdDom(TID_OFFPEAK_FORM_INSTRUCTIONS, input.instructions, {
    timeoutMsg: "闲时任务 instructions 输入没有出现",
  });
  await clickTestIdByDom(TID_OFFPEAK_EDIT_SUBMIT, {
    timeoutMsg: "闲时任务创建提交按钮不可点击",
  });
}

async function waitForOffPeakScenarioCompletion(): Promise<OffPeakMockRequestRecord[]> {
  let latest: OffPeakMockRequestRecord[] = [];
  await browser.waitUntil(
    async () => {
      latest = await readOffPeakMockRequests();
      return latest.some((record) => record.stage === "parent-continuation");
    },
    {
      interval: 1000,
      timeout: 180000,
      timeoutMsg: "闲时 mock 没有完成 foreground subagent 场景",
    },
  );
  return latest;
}

async function readOffPeakMockRequests(): Promise<OffPeakMockRequestRecord[]> {
  const port = Number(process.env.ZCODE_OFFPEAK_MOCK_PORT ?? "45197");
  try {
    const response = await fetch(`http://127.0.0.1:${port}/__e2e/off-peak/requests`);
    if (!response.ok) return [];
    const body = (await response.json()) as {
      requests?: OffPeakMockRequestRecord[];
    };
    return Array.isArray(body.requests) ? body.requests : [];
  } catch {
    return [];
  }
}

function requireStage(
  records: readonly OffPeakMockRequestRecord[],
  stage: string,
): OffPeakMockRequestRecord {
  const record = records.findLast((candidate) => candidate.stage === stage);
  if (!record) {
    throw new Error(
      `闲时 mock 缺少请求阶段 ${stage}: ${JSON.stringify(
        records.map((candidate) => ({
          model: candidate.model,
          stage: candidate.stage,
        })),
      )}`,
    );
  }
  return record;
}

async function waitForOffPeakCardCompleted(title: string): Promise<void> {
  await browser.waitUntil(
    async () => {
      const text = await readOffPeakCardText(title);
      // Bug 原因：卡片成功终态的英文产品文案是 Succeeded，旧断言只接受 Completed。
      return /Completed|Succeeded|已完成/u.test(text ?? "");
    },
    {
      interval: 1000,
      timeout: 180000,
      timeoutMsg: `闲时任务没有进入 completed: ${title}`,
    },
  );
}

async function openOffPeakTab(): Promise<void> {
  await browser.waitUntil(
    () =>
      browser.execute((tabTestId) => {
        const tabGroup = document.querySelector<HTMLElement>(`[data-testid="${tabTestId}"]`);
        const offPeakButton = Array.from(
          tabGroup?.querySelectorAll<HTMLButtonElement>("button") ?? [],
        ).find((button) => /闲时任务|Idle/u.test(button.textContent ?? ""));
        if (!offPeakButton) return false;
        offPeakButton.click();
        return true;
      }, TID_OFFPEAK_TAB),
    {
      interval: 500,
      timeout: 30000,
      timeoutMsg: "Automations 没有出现闲时任务标签",
    },
  );
}

async function readOffPeakCardText(title: string): Promise<string | null> {
  return browser.execute(
    (cardTestId, expectedTitle) =>
      Array.from(document.querySelectorAll<HTMLElement>(`[data-testid="${cardTestId}"]`))
        .find((card) => card.textContent?.includes(expectedTitle))
        ?.textContent?.trim() ?? null,
    TID_OFFPEAK_CARD,
    title,
  );
}

async function openOffPeakTaskSession(title: string): Promise<void> {
  await browser.waitUntil(
    async () =>
      browser.execute(
        (cardTestId, expectedTitle) => {
          const card = Array.from(
            document.querySelectorAll<HTMLElement>(`[data-testid="${cardTestId}"]`),
          ).find((candidate) => candidate.textContent?.includes(expectedTitle));
          const sessionButton = Array.from(
            card?.querySelectorAll<HTMLButtonElement>("button") ?? [],
          ).find((button) => !button.dataset.testid);
          if (!sessionButton) return false;
          sessionButton.click();
          return true;
        },
        TID_OFFPEAK_CARD,
        title,
      ),
    {
      interval: 500,
      timeout: 30000,
      timeoutMsg: `闲时任务卡片没有出现 session 跳转入口: ${title}`,
    },
  );
}
