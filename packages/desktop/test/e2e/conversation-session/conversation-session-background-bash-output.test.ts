import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { clearAppData, getE2EAppDataPaths } from "../helpers/desktop-app.js";
import { resolveE2ERuntimePath } from "../helpers/e2e-runtime-paths.js";
import { ensureToolCrossProductFullAccessMode } from "../helpers/conversation-session-tool-cross-product.js";
import { countUpstreamRequests } from "../helpers/conversation-session-network.js";
import {
  getV4PaneSnapshot,
  openV4ComposerRunningBackgroundWorks,
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4Prompt,
  startNewV4Draft,
  waitForV4AssistantMessageContaining,
  setV4ElectronWindowSize,
} from "../helpers/v4-conversation.js";

const ROOT = resolveE2ERuntimePath("background-bash-output", "中文 空格");
const names: string[] = [];
const outputFiles = new Set<string>();
const details = () =>
  $('[role="tabpanel"][data-state="active"] [data-testid="background-bash-details"]');
const body = () =>
  $('[role="tabpanel"][data-state="active"] [data-testid="background-bash-output"]');
async function release(name: string, phase: number) {
  await writeFile(join(ROOT, `${name}.${phase}.release`), "go");
}
async function text() {
  return body().getText();
}
async function contains(value: string) {
  await browser.waitUntil(async () => (await text()).includes(value), {
    timeout: 15000,
    timeoutMsg: `后台详情缺少 ${value}`,
  });
}
async function openRow() {
  await openV4ComposerRunningBackgroundWorks(30000);
  const row = await $('[data-testid="background-bash-open"]');
  await row.waitForClickable();
  await row.click();
  await details().waitForDisplayed();
}
async function launch(name: string) {
  names.push(name);
  await startNewV4Draft();
  // 新草稿会恢复 build；每次固定权限前置，避免把审批等待误判为输出未刷新。
  await ensureToolCrossProductFullAccessMode();
  await sendV4Prompt(`E2E_BGV_${name}: Run the exact background Bash fixture.`);
  await waitForV4AssistantMessageContaining(`E2E_BGV_${name}_DONE`, 60000);
  const sessionId = (await getV4PaneSnapshot()).sessionId!;
  const outputPath = join(
    getE2EAppDataPaths().storageRoot,
    "cli",
    "exec",
    sessionId,
    `toolu_bgv_${name}-stdout.log`,
  );
  outputFiles.add(outputPath);
  await openRow();
  await contains(`${name}_STDERR_中文`);
  return { sessionId, outputPath };
}
async function terminal() {
  await browser.waitUntil(async () => (await details().getAttribute("data-status")) !== "running", {
    timeout: 15000,
  });
}
async function expectStatusBarAlignment() {
  const gaps = await browser.execute(() => {
    const pane = document.querySelector('[role="tabpanel"][data-state="active"]')!;
    const bar = pane.querySelector('[data-testid="background-bash-statusbar"]')!;
    const file = pane.querySelector('[data-testid="background-bash-file"]')!;
    const running = pane.querySelector('[data-testid="background-bash-running"]');
    const style = getComputedStyle(bar);
    return {
      right:
        bar.getBoundingClientRect().right -
        Number.parseFloat(style.paddingRight) -
        file.getBoundingClientRect().right,
      left: running
        ? running.getBoundingClientRect().left -
          bar.getBoundingClientRect().left -
          Number.parseFloat(style.paddingLeft)
        : 0,
      sameColor: !running || getComputedStyle(file).color === getComputedStyle(running).color,
    };
  });
  expect(Math.abs(gaps.right)).toBeLessThanOrEqual(1);
  expect(Math.abs(gaps.left)).toBeLessThanOrEqual(1);
  expect(gaps.sameColor).toBe(true);
}
async function alive(name: string) {
  const pid = Number(await readFile(join(ROOT, `${name}.pid`), "utf8"));
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readAgentLogs() {
  const logDir = process.env.ZCODE_LOG_DIR!;
  const files = (await readdir(logDir)).filter((file) => file.endsWith(".jsonl"));
  return (await Promise.all(files.map((file) => readFile(join(logDir, file), "utf8")))).join("\n");
}

describe("后台 Bash 实时输出详情", () => {
  before(async function () {
    this.timeout(120000);
    await rm(ROOT, { recursive: true, force: true });
    await mkdir(ROOT, { recursive: true });
    await copyFile(
      new URL(
        "../fixtures/fs/conversation-session/background-bash-output/writer.cjs",
        import.meta.url,
      ),
      join(ROOT, "writer.cjs"),
    );
    await prepareV4ConversationE2E();
    await ensureToolCrossProductFullAccessMode();
    await setV4ElectronWindowSize(1440, 1000);
  });
  afterEach(async () => {
    // 所有 barrier 均由用例拥有；断言失败也释放 producer，避免遗留后台任务。
    for (const name of names.splice(0)) {
      for (let phase = 1; phase <= 3; phase++) await release(name, phase);
      await browser.waitUntil(async () => !(await alive(name)), { timeout: 15000 });
    }
  });
  after(async () => {
    for (const file of outputFiles) await rm(file, { force: true });
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  for (const [caseId, name] of [
    ["BGV01", "EXPLICIT"],
    ["BGV02", "AUTO"],
  ]) {
    it(`${caseId}: 退出前两次更新、两流中文无换行、8 KiB 淘汰与复用标签页 (${name})`, async function () {
      this.timeout(120000);
      const { outputPath } = await launch(name!);
      expect(await details().$('button[data-testid="background-bash-stop"]').isExisting()).toBe(
        false,
      );
      expect(await details().$("header").isExisting()).toBe(false);
      expect(await details().$('[data-testid="background-bash-running"]').isDisplayed()).toBe(true);
      await expectStatusBarAlignment();
      const requests = await countUpstreamRequests({ includes: [`E2E_BGV_${name}`] });
      const id = await details().getAttribute("data-work-id");
      await openRow();
      expect(await $$(`[data-testid="background-bash-details"][data-work-id="${id}"]`).length).toBe(
        1,
      );
      await release(name!, 1);
      await contains(`${name}_SECOND_中文`);
      expect(await text()).not.toContain(`${name}_FIRST`);
      expect(Buffer.byteLength(await text())).toBeLessThanOrEqual(8192);
      expect(await details().$('[data-testid="background-bash-truncated"]').isExisting()).toBe(
        false,
      );
      expect(
        await browser.execute(() => {
          const pane = document.querySelector('[role="tabpanel"][data-state="active"]');
          const running = pane?.querySelector('[data-testid="background-bash-running"]');
          const output = pane?.querySelector('[data-testid="background-bash-scroll"]');
          return Boolean(
            running &&
            output &&
            running.getBoundingClientRect().bottom <= output.getBoundingClientRect().top + 1,
          );
        }),
      ).toBe(true);
      await expectStatusBarAlignment();
      expect((await stat(outputPath)).size).toBeGreaterThan(8192);
      await release(name!, 2);
      await contains(`${name}_THIRD_no_newline`);
      if (name === "EXPLICIT")
        await browser.saveScreenshot(
          join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "background-bash-live.png"),
        );
      expect(await alive(name!)).toBe(true);
      expect(await details().getAttribute("data-status")).toBe("running");
      expect(await countUpstreamRequests({ includes: [`E2E_BGV_${name}`] })).toBe(requests);
      await release(name!, 3);
      await terminal();
      await contains(`${name}_FINAL`);
      expect(await details().getAttribute("data-status")).toBe("completed");
      expect(await details().$('[data-testid="background-bash-running"]').isExisting()).toBe(false);
      await expectStatusBarAlignment();
      if (name === "EXPLICIT") {
        const logDir = process.env.ZCODE_E2E_RUNTIME_LOG_DIR;
        expect(logDir).toBeTruthy();
        const files = (await readdir(logDir!)).filter((file) => file.endsWith(".log"));
        const logs = (
          await Promise.all(files.map((file) => readFile(join(logDir!, file), "utf8")))
        ).join("\n");
        // 成功日志曾随每秒轮询持续落盘；先确认真实 RPC 日志存在，再验证该查询被 debug 门控。
        expect(logs).toContain("[rpc:call]");
        expect(logs).not.toContain("[rpc:call] zcode-agent.backgroundBashOutputV4 OK");
      }
    });
  }

  it("BGV03: 向上滚动冻结、后台结束保留阅读位置、回到最新显示最终窗口", async function () {
    this.timeout(120000);
    await launch("PAUSE");
    const firstWindow = await text();
    const hiddenDetails = await details();
    await $('[role="tabpanel"][data-state="active"] [data-testid="background-bash-file"]').click();
    await browser.waitUntil(async () => !(await hiddenDetails.isDisplayed()), { timeout: 5000 });
    // 等已发出的旧查询结束，再制造新内容；隐藏 tab 不能读取这次变化。
    await browser.pause(1200);
    await release("PAUSE", 1);
    await browser.pause(1500);
    expect(await hiddenDetails.$('[data-testid="background-bash-output"]').getHTML()).toContain(
      "PAUSE_FIRST",
    );
    expect(await hiddenDetails.$('[data-testid="background-bash-output"]').getHTML()).not.toContain(
      "PAUSE_SECOND",
    );
    expect(firstWindow).toContain("PAUSE_FIRST");
    await openRow();
    await contains("PAUSE_SECOND");
    const viewport = await $(
      '[role="tabpanel"][data-state="active"] [data-testid="background-bash-scroll"]',
    );
    await browser.waitUntil(
      async () => (await viewport.getAttribute("data-scroll-mask")) === "top",
      {
        timeout: 5000,
        timeoutMsg: "后台 Bash 吸底后没有顶部渐隐",
      },
    );
    expect((await viewport.getCSSProperty("mask-image")).value).toContain("linear-gradient");
    // 手动滚到底部必须恢复跟随；此前只有按钮调用 resume，实际到底后箭头仍常驻。
    await browser.execute(() => {
      const el = document.querySelector<HTMLElement>(
        '[role="tabpanel"][data-state="active"] [data-testid="background-bash-scroll"]',
      )!;
      el.scrollTop = 0;
      el.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await details().$('[data-testid="background-bash-resume"]').waitForDisplayed();
    await browser.execute(() => {
      const el = document.querySelector<HTMLElement>(
        '[role="tabpanel"][data-state="active"] [data-testid="background-bash-scroll"]',
      )!;
      el.scrollTop = el.scrollHeight;
      el.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    const bottomState = await browser.execute(() => {
      const pane = document.querySelector(
        '[role="tabpanel"][data-state="active"] [data-testid="background-bash-details"]',
      )!;
      const el = pane.querySelector('[data-testid="background-bash-scroll"]')!;
      return {
        following: pane.getAttribute("data-following"),
        bottomGap: el.scrollHeight - el.clientHeight - el.scrollTop,
      };
    });
    expect(bottomState.bottomGap).toBeLessThanOrEqual(8);
    await browser.waitUntil(
      async () => (await details().getAttribute("data-following")) === "true",
      {
        timeout: 5000,
        timeoutMsg: `手动到底后未恢复跟随: ${JSON.stringify(bottomState)}`,
      },
    );
    expect(await details().$('[data-testid="background-bash-resume"]').isExisting()).toBe(false);
    await release("PAUSE", 2);
    await contains("PAUSE_THIRD_no_newline");
    expect(await details().getAttribute("data-following")).toBe("true");
    await browser.execute(() => {
      const el = document.querySelector<HTMLElement>(
        '[role="tabpanel"][data-state="active"] [data-testid="background-bash-scroll"]',
      )!;
      el.scrollTop = (el.scrollHeight - el.clientHeight) / 2;
      el.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await browser.waitUntil(
      async () => (await viewport.getAttribute("data-scroll-mask")) === "both",
      {
        timeout: 5000,
        timeoutMsg: "后台 Bash 中间位置没有上下渐隐",
      },
    );
    await browser.execute(() => {
      const el = document.querySelector<HTMLElement>(
        '[role="tabpanel"][data-state="active"] [data-testid="background-bash-scroll"]',
      )!;
      el.scrollTop = 0;
      el.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await $(
      '[role="tabpanel"][data-state="active"] [data-testid="background-bash-resume"]',
    ).waitForDisplayed();
    const resume = await $(
      '[role="tabpanel"][data-state="active"] [data-testid="background-bash-resume"]',
    );
    expect(await resume.getText()).toBe("");
    expect(await resume.getAttribute("aria-label")).toMatch(/Scroll to bottom|滚动到底部/i);
    expect(
      await browser.execute(() => {
        const pane = document.querySelector('[role="tabpanel"][data-state="active"]')!;
        const button = pane.querySelector<HTMLElement>('[data-testid="background-bash-resume"]')!;
        const output = pane.querySelector<HTMLElement>('[data-testid="background-bash-scroll"]')!;
        const bar = pane.querySelector('[data-testid="background-bash-statusbar"]');
        const rect = button.getBoundingClientRect();
        const viewport = output.getBoundingClientRect();
        const style = getComputedStyle(button);
        return (
          !output.contains(button) &&
          !bar?.contains(button) &&
          style.position === "absolute" &&
          Math.abs(rect.width - rect.height) < 1 &&
          Number.parseFloat(style.borderRadius) >= rect.width / 2 &&
          Math.abs(rect.left + rect.width / 2 - viewport.left - viewport.width / 2) < 1 &&
          rect.bottom < viewport.bottom &&
          rect.bottom > viewport.bottom - 24 &&
          getComputedStyle(button.parentElement!).maskImage === "none"
        );
      }),
    ).toBe(true);
    await browser.saveScreenshot(
      join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "background-bash-paused.png"),
    );
    expect(await viewport.getAttribute("data-scroll-mask")).toBe("bottom");
    const frozen = await text();
    await release("PAUSE", 3);
    await terminal();
    expect(await text()).toBe(frozen);
    await $(
      '[role="tabpanel"][data-state="active"] [data-testid="background-bash-resume"]',
    ).click();
    await contains("PAUSE_FINAL");
    await browser.waitUntil(
      async () => (await viewport.getAttribute("data-scroll-mask")) === "top",
      {
        timeout: 5000,
        timeoutMsg: "后台 Bash 恢复吸底后渐隐未更新",
      },
    );
  });

  it("BGV04: 切换会话隔离标签页，返回立即读取仍在运行的原任务", async function () {
    this.timeout(120000);
    const first = await launch("SCOPE_A");
    const second = await launch("SCOPE_B");
    expect(first.sessionId).not.toBe(second.sessionId);
    expect(await text()).not.toContain("SCOPE_A");
    await release("SCOPE_A", 1);
    await selectV4TaskById(first.sessionId);
    await openRow();
    await contains("SCOPE_A_SECOND");
    expect(await text()).not.toContain("SCOPE_B");
    expect(await alive("SCOPE_A")).toBe(true);
    expect(await alive("SCOPE_B")).toBe(true);
  });

  it("BGV04: 子会话冷恢复后仍能读取原后台 Bash，完成后保留最终输出", async function () {
    this.timeout(360000);
    names.push("CHILD");
    await startNewV4Draft();
    await ensureToolCrossProductFullAccessMode();
    await sendV4Prompt("E2E_BGV_PARENT: Launch the exact background child fixture.");
    await waitForV4AssistantMessageContaining("E2E_BGV_PARENT_DONE", 60000);
    const rootSessionId = (await getV4PaneSnapshot()).sessionId;
    await openV4ComposerRunningBackgroundWorks(30000);
    const entry = await $('[data-running-subagent-session-trigger="true"]');
    await entry.waitForClickable({ timeout: 15000 });
    const childSessionId = await entry.getAttribute("data-child-session-id");
    expect(childSessionId).toBeTruthy();
    await entry.click();
    const openChildOutput = () =>
      browser.waitUntil(
        async () =>
          browser.execute(() => {
            const pane = document.querySelector('[role="tabpanel"][data-state="active"]');
            const button = pane?.querySelector<HTMLButtonElement>(
              '[data-testid="background-bash-open"]',
            );
            if (button) {
              button.click();
              return true;
            }
            const expand = pane?.querySelector<HTMLButtonElement>(
              '[data-status-section-trigger="terminal"]',
            );
            if (expand?.getAttribute("aria-expanded") === "false") expand.click();
            return false;
          }),
        { timeout: 15000, timeoutMsg: "子会话没有显示后台 Bash 入口" },
      );
    await openChildOutput();
    await details().waitForDisplayed();
    await contains("CHILD_STDERR_中文");
    const workId = await details().getAttribute("data-work-id");
    const outputTabId = await $(
      '[data-side-pane-tab-id^="bash-output:"][data-state="active"]',
    ).getAttribute("data-side-pane-tab-id");
    expect(workId).toBeTruthy();
    expect(await details().getAttribute("data-status")).toBe("running");

    // 旧任务由祖先 adapter 持有；必须实际释放 child publisher，再经普通订阅创建新 record。
    // 保留输出 tab，但关闭 child conversation 的订阅，让现有 120s grace / 60s tick 自然淘汰。
    await browser.execute((sessionId) => {
      document
        .querySelector<HTMLButtonElement>(
          `[data-side-pane-tab-id^="subagent-session:"][data-side-pane-tab-id$=":${sessionId}"] button`,
        )!
        .click();
    }, childSessionId);
    const releasedMessage = `release detached live child publisher session=${childSessionId}`;
    await browser.waitUntil(async () => (await readAgentLogs()).includes(releasedMessage), {
      timeout: 260000,
      interval: 1000,
      timeoutMsg: "子会话 publisher 未实际释放",
    });
    expect(await alive("CHILD")).toBe(true);
    await browser.saveScreenshot(
      join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "background-bash-child-released.png"),
    );
    // Agent 摘要在已折叠的执行历史中；先展开历史，再从真实摘要入口重新订阅 child。
    const history = await $(
      `[data-session-id="${rootSessionId}"] [data-testid^="chat-assistant-history-trigger-"]`,
    );
    if ((await history.getAttribute("aria-expanded")) === "false") await history.click();
    const childSummary = await $(`[data-testid="v4-subagent-open-side-pane-${childSessionId}"]`);
    await childSummary.scrollIntoView();
    await childSummary.waitForClickable();
    await childSummary.click();
    const resumedMessage = `cold resume flight cleared session=${childSessionId}`;
    await browser.waitUntil(async () => (await readAgentLogs()).includes(resumedMessage), {
      timeout: 15000,
      timeoutMsg: "重新打开子会话未完成冷恢复",
    });
    // 冷恢复不新增历史后台任务目录；回到之前保留的输出 tab，验证它仍能查询原任务。
    await $(`[data-side-pane-tab-id="${outputTabId}"]`).click();
    await details().waitForDisplayed();
    expect(await details().getAttribute("data-work-id")).toBe(workId);
    const requests = await countUpstreamRequests({ includes: ["E2E_BGV_CHILD_WORK:"] });
    await release("CHILD", 1);
    await contains("CHILD_SECOND");
    await release("CHILD", 2);
    await contains("CHILD_THIRD_no_newline");
    expect(await alive("CHILD")).toBe(true);
    expect(await countUpstreamRequests({ includes: ["E2E_BGV_CHILD_WORK:"] })).toBe(requests);
    await writeFile(
      join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "background-bash-cold-resume.json"),
      JSON.stringify(
        {
          childSessionId,
          rootSessionId,
          workId,
          releasedMessage,
          resumedMessage,
          requests,
          output: await text(),
        },
        null,
        2,
      ),
    );
    await release("CHILD", 3);
    await terminal();
    await contains("CHILD_FINAL");
    expect(await details().getAttribute("data-status")).toBe("completed");
    expect((await getV4PaneSnapshot()).sessionId).toBe(rootSessionId);
  });

  it("BGV05: 文件删除明确报错、保留上一份输出，失败与关闭详情不停止进程", async function () {
    this.timeout(120000);
    const { outputPath } = await launch("ERROR");
    const previous = await text();
    await rm(outputPath);
    const error = await $(
      '[role="tabpanel"][data-state="active"] [data-testid="background-bash-details"] [role="alert"]',
    );
    await error.waitForDisplayed({ timeout: 15000 });
    expect(await error.getText()).toMatch(/无法读取|Could not read/);
    expect(await text()).toBe(previous);
    expect(await alive("ERROR")).toBe(true);
    await $('[data-side-pane-tab-id^="bash-output:"][data-state="active"] button').click();
    expect(await alive("ERROR")).toBe(true);
  });

  it("BGV06: 原后台条目 Stop 后详情保留终态输出，详情本身没有停止按钮", async function () {
    this.timeout(120000);
    await launch("STOP");
    await openV4ComposerRunningBackgroundWorks(30000);
    const id = await details().getAttribute("data-work-id");
    await $(`[data-testid="v4-background-work-cancel-${id}"]`).click();
    await terminal();
    expect(await details().getAttribute("data-status")).toBe("cancelled");
    await browser.waitUntil(async () => !(await alive("STOP")), { timeout: 15000 });
    await contains("STOP_STDERR_中文");
    await $(
      '[role="tabpanel"][data-state="active"] [data-testid="background-bash-file"]',
    ).waitForDisplayed();
  });
});
