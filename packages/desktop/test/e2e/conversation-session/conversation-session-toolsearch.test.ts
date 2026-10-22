import { BUILTIN_MODEL_PROVIDER_IDS } from "@zcode/shared";
import { clearAppData } from "../helpers/desktop-app.js";
import { skipOccupationOnboardingIfPresent } from "../helpers/occupation-onboarding.js";
import {
  restartIntoWorkspace,
  seedBigModelConnectionSelection,
  seedBigModelOAuthCredential,
} from "../helpers/model-provider-restart.js";
import {
  prepareV4ConversationE2E,
  switchV4Model,
  sendV4Prompt,
  waitForV4TimelineContaining,
  getV4PaneSnapshot,
  selectV4TaskById,
  waitForV4Pane,
} from "../helpers/v4-conversation.js";
import {
  readToolSearchRequests,
  TOOLSEARCH_TODO_CALL_ID,
  TOOLSEARCH_DONE,
} from "../helpers/toolsearch-provider.js";

describe("ToolSearch Desktop 默认关闭与冷恢复", () => {
  const providerId = BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan;
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("TS01/TS04: Coding Plan 默认完整目录，直接执行 TodoWrite 后冷恢复保持关闭", async function () {
    this.timeout(180_000);
    // 批量运行时会保留测试账号，但新 renderer profile 仍需完成职业引导。
    await skipOccupationOnboardingIfPresent();
    await prepareV4ConversationE2E({ skipProvider: true });
    await restartIntoWorkspace({
      afterElectronProcessExit: async () => {
        await seedBigModelConnectionSelection({ kind: "individual-coding-plan" });
        await seedBigModelOAuthCredential();
      },
    });
    await switchV4Model(providerId, "GLM-5.3", "");
    await sendV4Prompt("E2E_TOOLSEARCH_INITIAL 请搜索 TodoWrite，然后记录已完成的验证任务。");
    await waitForV4TimelineContaining(TOOLSEARCH_DONE, 60_000);
    const requests = await readToolSearchRequests();
    const first = requests[0]!;
    expect(first.requestJson.tools!.some((tool) => tool.name === "ToolSearch")).toBe(false);
    expect(first.requestJson.tools!.some((tool) => tool.name === "TodoWrite")).toBe(true);
    expect(first.requestHeaders["anthropic-beta"] ?? "").not.toContain("advanced-tool-use");
    assertTodoResult(requests);
    await waitForV4Pane((s) => !s.canStop, "搜索轮未结束", 30_000);
    const sessionId = (await getV4PaneSnapshot()).sessionId;
    expect(sessionId).toBeTruthy();
    await restartIntoWorkspace();
    await selectV4TaskById(sessionId!);
    const before = (await readToolSearchRequests()).length;
    await sendV4Prompt("E2E_TOOLSEARCH_COLD 继续验证已加载的工具。");
    await waitForV4TimelineContaining(TOOLSEARCH_DONE, 60_000);
    await browser.waitUntil(async () => (await readToolSearchRequests()).length > before, {
      timeout: 30_000,
    });
    await waitForV4Pane((s) => !s.canStop, "冷恢复轮未结束", 30_000);
    const coldRequests = (await readToolSearchRequests()).slice(before);
    expect(coldRequests).toHaveLength(1);
    const coldRequest = coldRequests[0]!;
    expect(
      coldRequest.requestJson.tools!.find((tool) => tool.name === "TodoWrite")?.defer_loading,
    ).toBeUndefined();
    assertTodoResult([coldRequest]);
  });
});

function assertTodoResult(requests: Awaited<ReturnType<typeof readToolSearchRequests>>) {
  // TodoWrite 由专用 Todo UI 投影；不能依赖默认隐藏的通用工具卡来证明执行成功。
  const result = requests
    .flatMap(({ requestJson }) =>
      requestJson.messages.flatMap((message) =>
        Array.isArray(message.content) ? message.content : [],
      ),
    )
    .find((block) => block.type === "tool_result" && block.tool_use_id === TOOLSEARCH_TODO_CALL_ID);
  expect(result).toBeDefined();
  expect(result?.is_error).not.toBe(true);
  expect(JSON.parse(String(result?.content))).toMatchObject({
    todos: [{ content: "Verify ToolSearch", status: "completed" }],
  });
}
