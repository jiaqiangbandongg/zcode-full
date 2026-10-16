import { readFile } from "node:fs/promises";
import { clearAppData } from "../../../helpers/desktop-app.js";
import {
  getV4PaneSnapshot,
  prepareV4ConversationE2E,
  sendV4PromptAndWaitAccepted,
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
} from "../../../helpers/v4-conversation.js";
import { waitForToolCallBlockByToolName } from "../../../helpers/conversation-session-tool.js";
import {
  restartIntoWorkspace,
  seedReplayProvider,
} from "../../../helpers/model-provider-restart.js";

const AGENT_TYPE = "e2e-team-scope-reviewer";
const PARENT_MARKER = "E2E_SUBAGENT_TEAM_SCOPE_PARENT";
const CHILD_MARKER = "E2E_SUBAGENT_TEAM_SCOPE_CHILD";
const PARENT_DONE = "E2E_SUBAGENT_TEAM_SCOPE_PARENT_DONE";
const TEAM_PROVIDER_ID = "team-plan:e2e-missing-scope";
const TEAM_MODEL_ID = "team-model";

/** Team child 缺少 organization/project 时，在 child provider 请求之前失败，父会话仍可继续。 */
describe("Subagent Team scope 缺失 E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("F-PLAN-007/F-SUBAGENT-019: Team child 无范围时显示权限错误且不静默降级", async function () {
    this.timeout(180000);
    await prepareV4ConversationE2E({ skipProvider: true });
    await seedReplayProvider({
      enabled: false,
      id: TEAM_PROVIDER_ID,
      models: [TEAM_MODEL_ID],
      name: "E2E Team Plan（缺少组织范围）",
    });
    await restartIntoWorkspace();
    await prepareV4ConversationE2E({ skipProvider: true });

    const marker = `${PARENT_MARKER}_${Date.now()}`;
    await sendV4PromptAndWaitAccepted(
      `${marker}: invoke the Agent tool with subagent_type "${AGENT_TYPE}" for ${CHILD_MARKER}, then reply exactly ${PARENT_DONE}.`,
      marker,
      "Team scope parent prompt 没有被接受",
    );
    await waitForToolCallBlockByToolName("Agent", 60000);
    await waitForV4AssistantMessageContaining(PARENT_DONE, 90000);
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
      "Team scope child 失败后父会话没有回到 idle",
      90000,
    );

    const capturePath = process.env.E2E_PROVIDER_CAPTURE_PATH?.trim();
    const artifact = capturePath
      ? (JSON.parse(await readFile(capturePath, "utf8")) as {
          records?: Array<{ requestJson?: unknown }>;
        })
      : { records: [] };
    const captureText = JSON.stringify(artifact.records ?? []);
    expect(captureText).not.toContain(CHILD_MARKER);
    expect((await getV4PaneSnapshot()).timelineText).toMatch(
      /Team|组织|项目|scope|permission|权限/u,
    );
  });
});
