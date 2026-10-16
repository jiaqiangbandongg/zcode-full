// ZCT-2098314627607224320：首发迁移 Root 后，再新建任务必须继承最近接纳的权限。
// 不给新 Root 手工写配置；真实点击 New Task，先检查回退，再以 Write 验证执行权限。
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TID_CHAT_MODE_SELECT_TRIGGER } from "@zcode/shared";
import { clearAppData, DEFAULT_WORKSPACE } from "../../../helpers/desktop-app.js";
import { resolveE2ERuntimePath, resolveE2EToolPath } from "../../../helpers/e2e-runtime-paths.js";
import { getLatestUpstreamToolResultByToolCallId } from "../../../helpers/conversation-session-network.js";
import { getV4ComposerDraftScopeSnapshot } from "../../../helpers/conversation-session-store.js";
import {
  getV4ModelConfig,
  getV4PaneSnapshot,
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4PromptAndWaitAccepted,
  startNewV4Draft,
  switchV4Mode,
  waitForV4ComposerSelectionReady,
  waitForV4TimelineContaining,
} from "../../../helpers/v4-conversation.js";

const CASE_NAME = "conversation-session-composer-recent-mode";
const CASE_DIR = resolveE2ERuntimePath(CASE_NAME);
const OUTPUT_PATH = resolveE2EToolPath(CASE_NAME, "result.txt");
const EVIDENCE_DIR = join(
  process.env.ZCODE_E2E_ARTIFACT_DIR ?? join(process.cwd(), ".e2e-artifacts"),
  CASE_NAME,
);

async function captureState(step: string) {
  await mkdir(EVIDENCE_DIR, { recursive: true });
  const permissionTrigger = $(`[data-testid="${TID_CHAT_MODE_SELECT_TRIGGER}"]`);
  await permissionTrigger.waitForDisplayed();
  const state = {
    pane: await getV4PaneSnapshot(),
    composer: await getV4ModelConfig(),
    rootDraft: await getV4ComposerDraftScopeSnapshot(DEFAULT_WORKSPACE, null),
    permissionLabel: await permissionTrigger.getText(),
  };
  await writeFile(join(EVIDENCE_DIR, `${step}.json`), JSON.stringify(state, null, 2));
  await browser.saveScreenshot(join(EVIDENCE_DIR, `${step}.png`));
  return state;
}

async function expectMode(mode: string) {
  await $(`[data-testid="${TID_CHAT_MODE_SELECT_TRIGGER}"]`).waitForDisplayed();
  await waitForV4ComposerSelectionReady();
  expect((await getV4ModelConfig()).mode).toBe(mode);
}

describe("Composer Recent 权限继承", () => {
  after(async () => {
    await clearAppData();
    await rm(CASE_DIR, { recursive: true, force: true });
  });

  it("I74/I75: 完全访问首发后 New Task 保留权限，已有草稿与 Session 选择仍各自独立", async () => {
    await rm(CASE_DIR, { recursive: true, force: true });
    await mkdir(CASE_DIR, { recursive: true });
    await prepareV4ConversationE2E();
    await expectMode("build");
    await switchV4Mode("yolo");
    await expectMode("yolo");
    const selected = await getV4ModelConfig();
    await sendV4PromptAndWaitAccepted(
      "E2E_COMPOSER_RECENT_MODE_SEED 请回复测试标记。",
      "E2E_COMPOSER_RECENT_MODE_SEED",
      "第一次输入未被接纳",
    );
    await waitForV4TimelineContaining("RECENT_MODE_STREAMING");
    const firstSession = (await getV4PaneSnapshot()).sessionId!;
    const first = await captureState("01-accepted-yolo");
    expect(first.composer.mode).toBe("yolo");
    expect(first.pane.canStop).toBe(true);

    await startNewV4Draft();
    await waitForV4ComposerSelectionReady();
    const next = await captureState("02-new-task-mode");
    // 修复前这里稳定取得 actual=build，证明是新 Root 初始化回退。
    expect(next.composer.mode).toBe("yolo");
    expect(next.rootDraft.mode).toBe("yolo");
    expect(next.composer).toMatchObject({ provider: selected.provider, model: selected.model });
    await sendV4PromptAndWaitAccepted(
      `E2E_COMPOSER_RECENT_MODE_WRITE 请写入 ${OUTPUT_PATH}`,
      "E2E_COMPOSER_RECENT_MODE_WRITE",
      "继承权限后的输入未被接纳",
    );
    await waitForV4TimelineContaining("RECENT_MODE_DONE", 60_000);
    const secondSession = (await getV4PaneSnapshot()).sessionId!;
    expect(secondSession).not.toBe(firstSession);
    expect(await readFile(join(CASE_DIR, "result.txt"), "utf8")).toBe("RECENT_MODE_WRITE_OK\n");
    expect(
      (await getLatestUpstreamToolResultByToolCallId("toolu_recent_mode_write"))?.isError,
    ).toBe(false);
    await captureState("03-inherited-mode-executed");

    await startNewV4Draft();
    await expectMode("yolo");
    await switchV4Mode("plan");
    await selectV4TaskById(firstSession);
    await expectMode("yolo");
    await switchV4Mode("edit");
    await selectV4TaskById(secondSession);
    await expectMode("yolo");
    await startNewV4Draft();
    await expectMode("yolo");
    await $('[data-testid="v4-composer-plan-marker"]').waitForDisplayed();
    await browser.refresh();
    await expectMode("yolo");
    await $('[data-testid="v4-composer-plan-marker"]').waitForDisplayed();
    await selectV4TaskById(firstSession);
    // 刷新后的缓存草稿可先于历史投影就绪；必须等旧 Snapshot 恢复后再断言不被覆盖。
    await waitForV4TimelineContaining("RECENT_MODE_STREAMING");
    await expectMode("edit");
    await captureState("04-session-draft-isolation");
  });
});
