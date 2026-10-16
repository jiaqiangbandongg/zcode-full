import { TID_CHAT_WORKFLOW_RUN_DIGEST } from "@zcode/shared";
import { clearAppData } from "../../../helpers/desktop-app.js";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
} from "../../../helpers/v4-conversation.js";
import { waitForToolCallBlockByToolName } from "../../../helpers/conversation-session-tool.js";

// 留白（docs/dynamic-workflow/presentation.md「Holes on the timeline」、docs/dynamic-workflow/launch.md
// 「The `FillWorkflowHole` tool」、docs/dynamic-workflow/transcript-and-notifications.md「The hole row's live state」）
// 的三条桌面链路：run 卡上的留白站与等待态、通知行的三态、补全之后卡与侧板长出新的站。
//
// ⚠ 本用例按回放夹具驱动：需要一份录制好的 `dynamic-workflow-holes` 回放（主代理先 CreateWorkflow
// 一个带 `hole<Plan>("决定分组")` 的脚本，再在收到留白通知后 FillWorkflowHole 两个阶段），夹具尚未录制，
// 本文件写好即入 manual-review/pending，**没有在本机运行过**（会启动 Electron，接管用户桌面）。
// 选择器全是被测组件上的 data-testid，与 packages/ui/test 的静态渲染断言同一套抓手。
const RUN_DIGEST = `[data-testid^="${TID_CHAT_WORKFLOW_RUN_DIGEST}"]`;
// 留白 id 是名字的键（apps/zcode-cli/packages/dynamic-workflow/docs/analysis.md「Sites」）：「决定分组」→ 这个 id。
const DECIDE_HOLE_ID = "hole#21b40fca";

describe("动态工作流 · 留白", () => {
  before(async () => {
    await prepareV4ConversationE2E();
  });
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("DWH-01 卡上画出留白站，run 到达时变成等待态并长出「1 处留白待补全」", async function () {
    this.timeout(240000);
    await sendV4Prompt("跑一下 flaky-hunt 工作流（带留白的脚本）");
    await waitForToolCallBlockByToolName("CreateWorkflow", 120000);
    const digest = await $(RUN_DIGEST);
    await digest.waitForDisplayed({ timeout: 120000 });

    // 留白站：虚线灯 + 名字（类型不上界面）；触到它的轨道段是虚线；尾巴留白之后有 40px 残段。
    const holeStation = await digest.$(
      '[data-testid="workflow-timeline-station"][data-station-hole]',
    );
    await holeStation.waitForDisplayed({ timeout: 60000 });
    expect(await holeStation.getText()).toContain("决定分组");
    expect(await holeStation.getText()).not.toContain("Plan");
    await expect(
      digest.$('[data-testid="workflow-timeline-rail"][data-rail-dashed="true"]'),
    ).toBeExisting();
    await expect(digest.$('[data-testid="workflow-timeline-tail-stub"]')).toBeExisting();

    // 到达：灯换警示色描边、元数据写「等待补全」、表头长出笔芯片；灯不搏动。
    await browser.waitUntil(
      async () => (await holeStation.getAttribute("data-station-hole")) === "waiting",
      { timeout: 120000, timeoutMsg: "run 没有停在留白上" },
    );
    await expect(holeStation.$('[data-testid="workflow-hole-waiting"]')).toBeDisplayed();
    await expect(holeStation.$(".wf-lamp-hole-waiting")).toBeExisting();
    await expect(holeStation.$(".wf-lamp-running")).not.toBeExisting();
    const chip = await digest.$('[data-testid="workflow-digest-holes"]');
    await chip.waitForDisplayed({ timeout: 30000 });
    expect(await chip.getText()).toContain("1 处留白待补全");
    // 开着的留白是主代理车道上的一步，不是子代理：含 `hole()` 调用的那一站不多出「未命名子代理」。
    for (const pill of await digest.$$('[data-testid="workflow-agent-pill"]')) {
      expect(await pill.getText()).not.toContain("未命名子代理");
    }
  });

  it("DWH-02 通知行：笔图标、「工作流留白 · 等待补全」，展开体有提示、位置、草稿路径与等待时长", async function () {
    this.timeout(120000);
    const row = await $(
      '[data-testid^="chat-workflow-notification-row-"][data-hole-state="waiting"]',
    );
    await row.waitForDisplayed({ timeout: 120000 });
    expect(await row.getText()).toContain("工作流留白 · 等待补全");
    expect(await row.$('[data-testid="workflow-hole-notification-name"]').getText()).toBe(
      "决定分组",
    );
    await row.$('[role="button"]').click();
    const body = await row.$('[data-testid="workflow-hole-notification-body"]');
    await body.waitForDisplayed({ timeout: 10000 });
    expect(await body.getText()).toContain("补全须返回 Plan");
    await expect(body.$('[data-testid="workflow-hole-notification-draft"]')).toBeExisting();
    await expect(body.$('[data-testid="workflow-hole-notification-waited"]')).toBeExisting();
  });

  it("DWH-03 补全接进 run：补全行说「留白已补全」，卡长出头与新站，通知行翻成「留白已补全」", async function () {
    this.timeout(240000);
    await waitForToolCallBlockByToolName("FillWorkflowHole", 180000);
    await waitForV4AssistantMessageContaining("补全", 180000);
    const fillRow = await $(
      '[data-testid="workflow-tool-summary"][data-tool-call-id]:has([data-testid="workflow-summary-hole-name"])',
    );
    await fillRow.waitForDisplayed({ timeout: 60000 });
    expect(await fillRow.getText()).toContain("留白已补全");
    expect(await fillRow.$('[data-testid="workflow-summary-hole-phases"]').getText()).toContain(
      "个阶段",
    );

    const digest = await $(RUN_DIGEST);
    const head = await digest.$('[data-testid="workflow-timeline-fill-head"]');
    await head.waitForDisplayed({ timeout: 60000 });
    expect(await head.getText()).toContain("决定分组");
    // 刚接进 run 的两秒里框自己画一遍（警示色的一笔）；之后只在指针落在头上时画出。
    await expect(
      digest.$('[data-testid="workflow-timeline-fill-frame"][data-fill-fresh="true"]'),
    ).toBeExisting();
    await browser.waitUntil(
      async () =>
        !(await digest
          .$('[data-testid="workflow-timeline-fill-frame"][data-fill-fresh="true"]')
          .isExisting()),
      { timeout: 10000, timeoutMsg: "框的新鲜态没有在两秒后退去" },
    );
    // 站不点亮任何东西：指针落在补全写下的站上，框不画。
    await (
      await digest.$(`[data-testid="workflow-timeline-station"][data-fill="${DECIDE_HOLE_ID}"]`)
    ).moveTo();
    await expect(
      digest.$('[data-testid="workflow-timeline-fill-frame"][data-fill-on="true"]'),
    ).not.toBeExisting();
    // 头点亮它自己的框，而且只有这一个。
    await head.moveTo();
    await expect(
      digest.$(
        `[data-testid="workflow-timeline-fill-frame"][data-fill-frame="${DECIDE_HOLE_ID}"][data-fill-on="true"]`,
      ),
    ).toBeExisting();
    expect(
      await digest.$$('[data-testid="workflow-timeline-fill-frame"][data-fill-on="true"]'),
    ).toHaveLength(1);
    await expect(digest.$('[data-testid="workflow-digest-holes"]')).not.toBeExisting();

    const row = await $(
      '[data-testid^="chat-workflow-notification-row-"][data-hole-state="filled"]',
    );
    await row.waitForDisplayed({ timeout: 60000 });
    expect(await row.getText()).toContain("留白已补全");
  });

  it("DWH-04 侧板：留白节头、等待体，补全后的标题行（它是框的头）与不缩进的补全节；侧栏运行行写「决定分组 · 等待补全」", async function () {
    this.timeout(120000);
    const digest = await $(RUN_DIGEST);
    await (await digest.$('[data-testid="workflow-timeline-fill-head"]')).click();
    const heading = await $('[data-testid="workflow-run-fill-heading"]');
    await heading.waitForDisplayed({ timeout: 60000 });
    expect(await heading.getText()).toContain("决定分组");
    await expect(
      $(`[data-testid="workflow-run-phase"][data-phase-fill="${DECIDE_HOLE_ID}"]`),
    ).toBeExisting();
    // 标题行是这次补全的头：指针落上去，侧板画出同一个框（竖着）。
    await heading.moveTo();
    await expect(
      $(
        `[data-testid="workflow-run-fill-frame"][data-fill-frame="${DECIDE_HOLE_ID}"][data-fill-on="true"]`,
      ),
    ).toBeExisting();
    // 还开着的尾巴留白在侧板里是虚线灯 + 名字；类型不上界面。
    const tail = await $('[data-testid="workflow-run-phase"][data-phase-hole="open"]');
    await expect(tail).toBeExisting();
    expect(await tail.getText()).toContain("评判");
    expect(await tail.getText()).not.toContain("Verdict");
    // 侧栏运行行：run 停在第二处留白时写「评判 · 等待补全」，迷你轨道的那盏灯是虚线警示色。
    const line = await $('[data-workflow-run-line="true"]');
    await browser.waitUntil(async () => (await line.getText()).includes("等待补全"), {
      timeout: 120000,
      timeoutMsg: "侧栏运行行没有写「等待补全」",
    });
    await expect(line.$('[data-rail-hole="waiting"]')).toBeExisting();
    await expect($('[data-testid="workflow-run-hole-waiting"]')).toBeExisting();
    // 等待体里画主代理收到的提示语（run 状态 holes[].prompt，来自 hole-reached）。
    await expect($('[data-testid="workflow-run-hole-prompt"]')).toBeExisting();
    await expect($('[data-testid="workflow-run-holes"]')).toBeExisting();
  });
});
