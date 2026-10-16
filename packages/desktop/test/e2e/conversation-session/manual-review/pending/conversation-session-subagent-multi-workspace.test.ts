import { subagentUpdateCursor } from "../../../helpers/subagent-snapshot-wait.js";
import {
  useEnglishSubagentSettings,
  finishSubagentTurn,
} from "../../../helpers/subagent-refresh-conversation.js";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TID_PROJECT_ADD } from "@zcode/shared";
import { clearAppData, getE2EAppDataPaths } from "../../../helpers/desktop-app.js";
import {
  saveRefreshProfile,
  type RefreshProfile,
} from "../../../helpers/subagent-refresh-settings.js";
import {
  UPSTREAM_MODEL,
  UPSTREAM_PROVIDER_ID,
  UPSTREAM_ALTERNATE_MODEL,
  UPSTREAM_ALTERNATE_PROVIDER_ID,
  selectUpstreamModel,
  selectUpstreamThoughtLevel,
} from "../../../helpers/upstream-provider.js";
import {
  prepareV4ConversationE2E,
  getV4PaneSnapshot,
  selectV4TaskById,
  sendV4PromptAndWaitAccepted,
} from "../../../helpers/v4-conversation.js";
import { waitForActiveWorkspacePath } from "../../../helpers/workspace-agent-warmup.js";
import {
  readSubagentCapture,
  waitForSubagentRequest,
  assertSubagentProfile,
  readChildSessionIds,
  boundaryRpcReads,
} from "../../../helpers/subagent-refresh-capture.js";
import {
  assertParentRequestHistory,
  type CapturedPrompt,
} from "../../../helpers/provider-prefix.js";
import { exportPromptTrajectory } from "../../../helpers/prompt-trajectory-export.js";

const old: RefreshProfile = {
  name: "e2e-workspace-reviewer",
  description: "Workspace snapshot",
  prompt: "E2E_SMW_PROFILE_OLD",
  model: UPSTREAM_MODEL,
  provider: UPSTREAM_PROVIDER_ID,
  effort: "low",
  tools: ["Read"],
};
const updated: RefreshProfile = {
  ...old,
  prompt: "E2E_SMW_PROFILE_NEW",
  model: UPSTREAM_ALTERNATE_MODEL,
  provider: UPSTREAM_ALTERNATE_PROVIDER_ID,
  effort: "high",
  tools: ["Grep"],
};

describe("Subagent 多实际 workspace CLI", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });
  it("SHR14/SHR17: 无关项目不可读不阻断保存，两个 CLI/session 同时保持当前轮旧快照，保存后分别在下一轮刷新", async function () {
    this.timeout(240000);
    await prepareV4ConversationE2E();
    await useEnglishSubagentSettings();
    await saveRefreshProfile(old);
    await turn("A_SEED");
    const a = (await getV4PaneSnapshot()).sessionId!;
    const workspaceB = join(getE2EAppDataPaths().homeDir, "subagent-workspace-b");
    await mkdir(join(workspaceB, ".zcode", "agents"), { recursive: true });
    const dialog = await browser.electron.mock("dialog", "showOpenDialog");
    await dialog.mockResolvedValueOnce({ canceled: false, filePaths: [workspaceB] });
    await $(`[data-testid="${TID_PROJECT_ADD}"]`).click();
    const openFolder = $('[role="menuitem"]=Open folder');
    await openFolder.waitForClickable({ timeout: 15000 });
    await openFolder.click();
    await waitForActiveWorkspacePath(workspaceB);
    await selectUpstreamModel();
    await selectUpstreamThoughtLevel();
    await turn("B_SEED");
    const b = (await getV4PaneSnapshot()).sessionId!;
    expect(b).not.toBe(a);
    // 初始化与首个父轮各读取一次；两个实际 CLI 都从 Host 取得初始定义。
    const seedReads = await boundaryRpcReads();
    for (const id of [a, b])
      expect(seedReads.filter((r) => r.kind === "read" && r.sessionId === id)).toHaveLength(2);
    await selectV4TaskById(a);
    await send("A_HOLD");
    await started("A_HOLD");
    await selectV4TaskById(b);
    await send("B_HOLD");
    await started("B_HOLD");
    // 真实文件系统故障：B 的 agents 根目录暂时变成文件，读取必定 ENOTDIR，跨平台一致。
    // 此时两轮已经取到快照；用户配置保存不应再遍历 B。
    const blockedRoot = join(workspaceB, ".zcode", "agents");
    async function blockProject() {
      const removed = await subagentUpdateCursor();
      await rename(blockedRoot, blockedRoot + "-saved");
      await removed(undefined, [blockedRoot]);
      const failed = await subagentUpdateCursor();
      await writeFile(blockedRoot, "E2E_UNREADABLE_PROJECT_DIRECTORY");
      await failed(undefined, [blockedRoot]);
    }
    async function restoreProject() {
      const removed = await subagentUpdateCursor();
      await rm(blockedRoot);
      await removed(undefined, [blockedRoot]);
      await rename(blockedRoot + "-saved", blockedRoot);
    }
    await blockProject();
    try {
      await saveRefreshProfile(updated, old.name);
    } finally {
      await restoreProject();
    }
    expect(
      (await readSubagentCapture()).filter((r) =>
        ["smw-a-hold-child", "smw-b-hold-child"].includes(r.replay?.fixtureId ?? ""),
      ),
    ).toHaveLength(0);
    assertSubagentProfile(await waitForSubagentRequest("smw-b-hold-child"), old);
    await finish("B_HOLD");
    await turn("B_NEXT");
    assertSubagentProfile(await waitForSubagentRequest("smw-b-next-child"), updated);
    await selectV4TaskById(a);
    assertSubagentProfile(await waitForSubagentRequest("smw-a-hold-child"), old);
    await finish("A_HOLD");
    await turn("A_NEXT");
    assertSubagentProfile(await waitForSubagentRequest("smw-a-next-child"), updated);
    // A 的项目保存和执行不受 B 故障影响；B 先回退，文件事件恢复后继续使用最新用户配置。
    const project = { ...old, prompt: "E2E_SMW_PROFILE_PROJECT_A" };
    await blockProject();
    try {
      await saveRefreshProfile(project, undefined, {
        workspacePath: getE2EAppDataPaths().workspace,
      });
      await turn("A_PROJECT");
      assertSubagentProfile(await waitForSubagentRequest("smw-a-project-child"), project);
      await selectV4TaskById(b);
      const children = readChildSessionIds(b);
      await turn("B_FALLBACK");
      const fallback = await waitForSubagentRequest("smw-b-fallback-final");
      expect(JSON.stringify((fallback.requestJson as CapturedPrompt).messages.at(-1))).toMatch(
        /not found|unavailable/,
      );
      expect(readChildSessionIds(b)).toEqual(children);
    } finally {
      await restoreProject();
    }
    await turn("B_PROJECT");
    assertSubagentProfile(await waitForSubagentRequest("smw-b-project-child"), updated);
    const rpc = (await boundaryRpcReads()).filter(
      (r) => r.kind === "read" && [a, b].includes(r.sessionId),
    );
    const aPids = new Set(rpc.filter((r) => r.sessionId === a).map((r) => r.pid));
    const bPids = new Set(rpc.filter((r) => r.sessionId === b).map((r) => r.pid));
    expect(aPids.size).toBe(1);
    expect(bPids.size).toBe(1);
    expect([...aPids][0]).not.toBe([...bPids][0]);
    expect(new Set(rpc.map((r) => r.hostPid)).size).toBe(1);
    for (const [name, id] of [
      ["a", a],
      ["b", b],
    ] as const) {
      expect(rpc.filter((r) => r.sessionId === id)).toHaveLength(1 + (name === "b" ? 5 : 4));
      const requests = (await readSubagentCapture())
        .filter(
          (r) =>
            r.replay?.fixtureId?.startsWith(`smw-${name}-`) &&
            !r.replay.fixtureId.endsWith("-child") &&
            !r.replay.fixtureId.endsWith("-title"),
        )
        .map((r) => r.requestJson as CapturedPrompt);
      expect(requests).toHaveLength(name === "b" ? 9 : 7);
      assertParentRequestHistory(requests);
      const exported = await exportPromptTrajectory(id, `subagent-multi-workspace-${name}`);
      expect(exported.trajectories).toHaveLength(1);
      expect(exported.trajectories[0]?.requestCount).toBe(name === "b" ? 9 : 7);
    }
  });
});
async function send(stage: string) {
  const marker = `E2E_SMW_${stage}`;
  await sendV4PromptAndWaitAccepted(
    `${marker}: ${stage.endsWith("SEED") ? "Remember this session." : `Launch ${old.name} with prompt ${marker}_CHILD.`}`,
    marker,
    `未接收 ${marker}`,
  );
}
const finish = (stage: string) => finishSubagentTurn(`E2E_SMW_${stage}_DONE`, 90000);
async function turn(stage: string) {
  await send(stage);
  await finish(stage);
}
async function started(stage: string) {
  await browser.waitUntil(
    async () =>
      (await readSubagentCapture()).some((r) =>
        JSON.stringify((r.requestJson as CapturedPrompt)?.messages).includes(`E2E_SMW_${stage}:`),
      ),
    { timeout: 30000, timeoutMsg: `未开始 ${stage}` },
  );
}
