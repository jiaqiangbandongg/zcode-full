import { openMobilePairingPage } from "#e2e/helpers/mobile-pairing";
import { readV4UserMessagesInBrowser } from "#e2e/helpers/mobile-message-evidence";
import { releaseControlledReplay } from "#e2e/helpers/controlled-replay";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { parseRemoteWorkspaceIdentity } from "@zcode/shared";
import {
  TID_TASK_ITEM,
  TID_V4_COMPOSER_INPUT,
  TID_V4_COMPOSER_SEND,
  TID_V4_SESSION_PANE,
  TID_SSH_CONNECT_TRIGGER,
  testId,
} from "@zcode/shared/test-ids";
import { clearAppData, DEFAULT_WORKSPACE } from "../../../helpers/desktop-app.js";
import { openWorkspaceDraftFromSidebar } from "#e2e/helpers/workspace-agent-warmup";
import { disconnectRemoteSource } from "#e2e/helpers/remote-project-actions";
import {
  countUpstreamRequests,
  getUpstreamRequestEvidence,
  getUpstreamRequestRecordCount,
  waitForUpstreamRequest,
} from "../../../helpers/conversation-session-network.js";
import {
  connectSSHWorkspaceAndSendFirstTurn,
  listRemoteAgentProcesses,
  prepareSSHLifecycle,
  type SSHLifecycleProvider,
} from "../../../helpers/ssh-remote-lifecycle.js";
import {
  connectSSHWorkspace,
  prepareSSHConnectionPage,
  readSSHRuntimeConfig,
  readHostProcesses,
  readRemoteTabSnapshot,
  runSSHCommand,
} from "../../../helpers/ssh-remote-p0.js";
import {
  prepareV4ConversationE2E,
  getV4ConversationState,
  getV4Messages,
  getV4QueueItems,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
  waitForV4Pane,
  waitForV4QueueCount,
  waitForV4TimelineContaining,
} from "../../../helpers/v4-conversation.js";

const CASE_MARKER = "E2E_R3_MOBILE";
const artifactDir = resolve(process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/r3-mobile");
// Linux e2e 服务器上没有 macOS 版 Chrome：用 R3_MOBILE_CHROME 指向该机 playwright 下载的
// chromium（缺省仍回退开发机 macOS 路径），否则本 case 在服务器上直接起不了手机浏览器。
const CHROME =
  process.env.R3_MOBILE_CHROME?.trim() ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const MOBILE_VIEWPORT = { width: 390, height: 844 };
const run = promisify(execFile);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PwPage = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PwContext = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PwBrowser = any;

async function countRemoteSshSessions(container: string): Promise<number> {
  const { stdout } = await run("docker", [
    "exec",
    container,
    "sh",
    "-c",
    "ps -o user=,args= -C sshd | grep -c '^dev ' || true",
  ]);
  return Number.parseInt(stdout.trim() || "0", 10);
}

/** 打开 Desktop 的“移动端远程控制”对话框并拦截剪贴板取得配对链接（含配对材料，只留内存、不落记录）。 */
async function obtainPairUrl(): Promise<string> {
  await browser.execute(() => {
    const clipboard = navigator.clipboard;
    const original = clipboard.writeText.bind(clipboard);
    (
      window as Window & { __r3RestoreClipboard?: () => void; __r3PairUrl?: string }
    ).__r3RestoreClipboard = () => {
      clipboard.writeText = original;
    };
    clipboard.writeText = async (text: string) => {
      (window as Window & { __r3PairUrl?: string }).__r3PairUrl = text;
    };
  });
  const trigger = $('button[aria-label="移动端远程控制"]');
  await trigger.waitForClickable({ timeout: 30_000 });
  await trigger.click();
  await $('[data-testid="web-remote-control-dialog-scroll"]').waitForDisplayed({ timeout: 30_000 });
  await browser.waitUntil(
    () =>
      browser.execute(() => {
        const button = Array.from(
          document.querySelectorAll<HTMLButtonElement>(
            '[data-testid="web-remote-control-dialog-scroll"] button',
          ),
        ).find((b) => b.innerText.trim() === "复制链接" && !b.disabled);
        button?.click();
        return Boolean(button);
      }),
    {
      timeout: 60_000,
      interval: 500,
      timeoutMsg: `${CASE_MARKER}: 复制链接按钮不可用（relay 未就绪？）`,
    },
  );
  let url = "";
  await browser.waitUntil(
    async () => {
      url = (await browser.execute(
        () => (window as Window & { __r3PairUrl?: string }).__r3PairUrl ?? "",
      )) as string;
      return url.startsWith("http");
    },
    { timeout: 15_000, timeoutMsg: `${CASE_MARKER}: 没有取得配对链接` },
  );
  await browser.execute(() => {
    const w = window as Window & { __r3RestoreClipboard?: () => void; __r3PairUrl?: string };
    w.__r3RestoreClipboard?.();
    delete w.__r3RestoreClipboard;
    delete w.__r3PairUrl;
  });
  return url;
}

async function readDesktopMobileStatus(): Promise<string> {
  return browser.execute(
    () =>
      document
        .querySelector<HTMLElement>('[data-testid="web-remote-control-connection-card"]')
        ?.innerText.replace(/\s+/gu, " ")
        .slice(0, 200) ?? "",
  );
}

async function closeRemoteControlDialog(): Promise<void> {
  await browser.keys(["Escape"]);
  await browser
    .waitUntil(
      () =>
        browser.execute(
          () => !document.querySelector('[data-testid="web-remote-control-dialog-scroll"]'),
        ),
      { timeout: 10_000, timeoutMsg: `${CASE_MARKER}: 远程控制对话框没有关闭` },
    )
    .catch(() => undefined);
}

async function mobileText(page: PwPage): Promise<string> {
  return (await page.evaluate(() => document.body?.innerText ?? "")) as string;
}

async function mobileUserRows(page: PwPage): Promise<Array<{ id: string; text: string }>> {
  return page.evaluate(readV4UserMessagesInBrowser, testId(TID_V4_SESSION_PANE, "workspace-main"));
}

describe(`${CASE_MARKER}: 手机 viewport 经真实 relay 配对，选择 SSH task、断网恢复、双端交替输入`, () => {
  let provider: SSHLifecycleProvider | null = null;
  let mobileBrowser: PwBrowser = null;
  const facts: Record<string, unknown> = {};

  after(async () => {
    await mkdir(artifactDir, { recursive: true });
    await writeFile(resolve(artifactDir, "mobile.json"), JSON.stringify(facts, null, 2));
    await mobileBrowser?.close().catch(() => undefined);
    mobileBrowser = null;
    await provider?.tunnel.close().catch(() => undefined);
    provider = null;
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("R3A-MOB-01/02/03/07 配对成功且 Host/SSH/Agent 数不增；手机断网恢复独立 replay、桌面 continuous 持续；双端交替输入同一 FIFO 无丢失重复；手机无新建远程能力", async function () {
    this.timeout(40 * 60_000);
    const container = process.env.ZCODE_E2E_SSH_CONTAINER?.trim();
    if (!container) throw new Error(`${CASE_MARKER}: 缺少 ZCODE_E2E_SSH_CONTAINER`);
    const prepared = await prepareSSHLifecycle(CASE_MARKER, {
      apiType: "anthropic-messages",
      tunnelUsername: "tunnel",
    });
    provider = prepared.provider;
    const [workspaceA] = prepared.config.workspacePaths;
    const taskA = await connectSSHWorkspaceAndSendFirstTurn({
      caseMarker: CASE_MARKER,
      config: prepared.config,
      label: "A",
      provider,
      workspacePath: workspaceA,
    });
    const baseline = {
      hosts: (await readHostProcesses()).length,
      ssh: await countRemoteSshSessions(container),
      agents: (await listRemoteAgentProcesses(prepared.config)).length,
    };
    facts.baseline = baseline;

    // MOB-01：配对。
    const pairUrl = await obtainPairUrl();
    const parsed = new URL(pairUrl);
    facts.pairEntry = {
      origin: parsed.origin,
      pathname: parsed.pathname,
      hasPairingMaterial: Boolean(parsed.search || parsed.hash),
    };
    const { chromium } = (await import("playwright-core")) as {
      chromium: { launch(o: object): Promise<PwBrowser> };
    };
    mobileBrowser = await chromium.launch({ headless: true, executablePath: CHROME });
    let pairingAttempt = 0;
    const newMobileContext = async (): Promise<{ context: PwContext; page: PwPage }> => {
      const context = await mobileBrowser.newContext({
        viewport: MOBILE_VIEWPORT,
        isMobile: true,
        hasTouch: true,
        locale: "zh-CN",
      });
      const page = await context.newPage();
      await openMobilePairingPage(page, pairUrl, {
        artifactDir,
        caseMarker: CASE_MARKER,
        phase: `pairing-${++pairingAttempt}`,
        readySelector: `[data-testid="${testId(TID_TASK_ITEM, taskA.taskId)}"]`,
      });
      return { context, page };
    };
    const first = await newMobileContext();
    let mobile: PwPage = first.page;
    let mobileContext: PwContext = first.context;
    await browser.waitUntil(async () => (await readDesktopMobileStatus()).includes("手机已连接"), {
      timeout: 60_000,
      timeoutMsg: `${CASE_MARKER}: Desktop 未显示手机已连接`,
    });
    facts.paired = { desktopCard: await readDesktopMobileStatus() };
    await closeRemoteControlDialog();
    // 手机首页列出远程 workspace 与 SSH task；点击进入。
    const homeText = await mobileText(mobile);
    const hasNewRemoteEntry = await mobile.evaluate(
      (triggerId: string) =>
        Array.from(
          document.querySelectorAll<HTMLElement>(
            `[data-testid="${triggerId}"], button, [role="menuitem"]`,
          ),
        ).some(
          (node) =>
            node.getClientRects().length > 0 &&
            !node.hasAttribute("disabled") &&
            node.getAttribute("aria-disabled") !== "true" &&
            (node.dataset.testid === triggerId ||
              /新建远程|添加设备|新建连接|New remote|Add device|New connection/iu.test(
                node.innerText || node.getAttribute("aria-label") || "",
              )),
        ),
      TID_SSH_CONNECT_TRIGGER,
    );
    facts.mobileHome = {
      hasRemoteKind: homeText.includes("远程"),
      hasWorkspaceA: homeText.includes("r3-workspace-a"),
      hasTask: homeText.includes(taskA.firstPrompt.slice(0, 20)),
      summary: homeText.match(/\d+ 个工作区 · \d+ 个任务/u)?.[0] ?? null,
      hasNewRemoteEntry,
    };
    expect(hasNewRemoteEntry).toBe(false);
    const taskLocator = mobile.locator(`[data-testid="${testId(TID_TASK_ITEM, taskA.taskId)}"]`);
    await taskLocator.first().waitFor({ timeout: 30_000 });
    await taskLocator.first().click();
    await mobile.getByText(taskA.firstReply, { exact: false }).first().waitFor({ timeout: 60_000 });
    const afterOpen = {
      hosts: (await readHostProcesses()).length,
      ssh: await countRemoteSshSessions(container),
      agents: (await listRemoteAgentProcesses(prepared.config)).length,
    };
    facts.afterMobileOpen = afterOpen;
    expect(afterOpen.hosts).toBe(baseline.hosts);
    expect(afterOpen.ssh).toBeLessThanOrEqual(baseline.ssh);
    expect(afterOpen.agents).toBeLessThanOrEqual(baseline.agents);
    expect((await readRemoteTabSnapshot(taskA.identity)).remoteSessionId).toBe(
      taskA.remoteSessionId,
    );

    // MOB-02：桌面发起慢回合（running），手机断网 15s 再恢复：手机独立 replay 补齐，桌面持续推进。
    const slowStart = await getUpstreamRequestRecordCount();
    await sendV4Prompt(`${CASE_MARKER}_SLOW 慢慢回答`);
    await waitForV4TimelineContaining("R3_MOBILE_STREAMING", 60_000);
    await waitForUpstreamRequest(
      { lastUserMessageIncludes: [`${CASE_MARKER}_SLOW`] },
      `${CASE_MARKER}: 慢回合没有到达回放`,
      60_000,
      { afterIndex: slowStart - 1 },
    );
    await mobile
      .getByText(`${CASE_MARKER}_SLOW`, { exact: false })
      .first()
      .waitFor({ timeout: 30_000 });
    const mobileSawSlowStart = (await mobileText(mobile)).includes(`${CASE_MARKER}_SLOW`);
    await mobileContext.setOffline(true);
    await browser.pause(15_000);
    const desktopDuringOffline = await getV4ConversationState();
    expect(desktopDuringOffline.state).toBe("streaming");
    // 手机仍离线时结束桌面流，独立完成标记只能在手机恢复 replay 后出现。
    await releaseControlledReplay("r3-mob-slow");
    await waitForV4AssistantMessageContaining("R3_MOBILE_STREAM_DONE", 120_000);
    await waitForV4ConversationState(
      (s) => s.taskId === taskA.taskId && s.state === "idle",
      `${CASE_MARKER}: 慢回合没有收口`,
      120_000,
    );
    expect(await mobile.getByText("R3_MOBILE_STREAM_DONE", { exact: false }).count()).toBe(0);
    facts.desktopCompletedWhileMobileOffline = true;
    await mobileContext.setOffline(false);
    let mobileRecovered = false;
    for (let i = 0; i < 30 && !mobileRecovered; i += 1) {
      const text = await mobileText(mobile);
      mobileRecovered =
        text.includes("R3_MOBILE_STREAM_DONE") && !/连接中|重新连接/u.test(text.slice(0, 200));
      if (!mobileRecovered) await browser.pause(2_000);
    }
    facts.offlineRecovery = {
      mobileSawSlowStart,
      desktopStateDuringMobileOffline: desktopDuringOffline.state,
      mobileRecovered,
      desktopCard: await readDesktopMobileStatus().catch(() => ""),
    };
    expect(desktopDuringOffline.state).toBe("streaming");
    expect(mobileRecovered).toBe(true);
    expect(
      await countUpstreamRequests(
        {
          lastUserMessageIncludes: [`${CASE_MARKER}_SLOW`],
          excludes: ["Generate a concise title"],
        },
        { afterIndex: slowStart - 1 },
      ),
    ).toBe(1);

    // 隧道健康探针：远端 loopback 上的回放隧道端口在手机发送前必须仍可连接（区分隧道掉线与产品问题）。
    const tunnelPort = new URL(provider.tunnel.baseURL).port;
    const probeTunnel = async (label: string) => {
      const result = await runSSHCommand(
        prepared.config,
        `python3 - <<'PY'
import socket
s=socket.socket();s.settimeout(3)
try:
    s.connect(("127.0.0.1",${tunnelPort}));print("open")
except Exception as e:
    print("closed:"+str(e))
finally:
    s.close()
PY`,
      );
      const value = result.stdout.trim();
      (facts.tunnelProbes as Record<string, string>)[label] = value;
      return value;
    };
    facts.tunnelProbes = {};
    await probeTunnel("afterOfflineRecovery");

    // MOB-03：手机回合运行时桌面输入进入同一队列；释放后按顺序消费，两端各显示一次。
    const fifoStart = await getUpstreamRequestRecordCount();
    const mobilePrompt = `${CASE_MARKER}_FROM_MOBILE 请回复`;
    const composer = mobile.locator(`[data-testid="${TID_V4_COMPOSER_INPUT}"]`).first();
    await composer.waitFor({ timeout: 30_000 });
    await composer.click();
    await mobile.keyboard.type(mobilePrompt);
    await mobile.locator(`[data-testid="${TID_V4_COMPOSER_SEND}"]`).first().click();
    await waitForUpstreamRequest(
      { lastUserMessageIncludes: [`${CASE_MARKER}_FROM_MOBILE`] },
      `${CASE_MARKER}: 手机输入没有到达回放`,
      90_000,
      { afterIndex: fifoStart - 1 },
    ).catch(async (error) => {
      await probeTunnel("mobilePromptNoRequest");
      throw error;
    });
    await probeTunnel("afterMobilePromptRequest");
    await waitForV4AssistantMessageContaining("R3_MOBILE_FROM_MOBILE_RUNNING", 90_000);
    await waitForV4ConversationState(
      (s) => s.taskId === taskA.taskId && s.state === "streaming",
      `${CASE_MARKER}: 桌面没有看到手机回合运行`,
      30_000,
    );
    const desktopPrompt = `${CASE_MARKER}_FROM_DESKTOP 请回复`;
    await sendV4Prompt(desktopPrompt);
    await waitForV4QueueCount(1, 30_000);
    const queued = await getV4QueueItems();
    expect(queued[0]?.text).toContain(desktopPrompt);
    expect(
      await countUpstreamRequests(
        {
          lastUserMessageIncludes: [`${CASE_MARKER}_FROM_DESKTOP`],
          excludes: ["Generate a concise title"],
        },
        { afterIndex: fifoStart - 1 },
      ),
    ).toBe(0);
    facts.desktopInputQueuedBehindMobile = true;
    await releaseControlledReplay("r3-mob-from-mobile");
    await waitForV4AssistantMessageContaining("R3_MOBILE_FROM_MOBILE_REPLY", 90_000);
    await waitForUpstreamRequest(
      { lastUserMessageIncludes: [`${CASE_MARKER}_FROM_DESKTOP`] },
      `${CASE_MARKER}: 桌面输入没有到达回放`,
      90_000,
      { afterIndex: fifoStart - 1 },
    );
    await waitForV4AssistantMessageContaining("R3_MOBILE_FROM_DESKTOP_REPLY", 90_000);
    await waitForV4ConversationState(
      (s) => s.taskId === taskA.taskId && s.state === "idle",
      `${CASE_MARKER}: 桌面回合没有收口`,
      120_000,
    );
    await mobile
      .getByText("R3_MOBILE_FROM_DESKTOP_REPLY", { exact: false })
      .first()
      .waitFor({ timeout: 60_000 });
    const desktopUsers = (await getV4Messages("user")).map((m) => m.text ?? "");
    const mobileUsers = (await mobileUserRows(mobile)).map((row) => row.text);
    const sequence = (rows: string[]) =>
      rows
        .filter(
          (text) =>
            text.includes(`${CASE_MARKER}_FROM_MOBILE`) ||
            text.includes(`${CASE_MARKER}_FROM_DESKTOP`),
        )
        .map((text) => (text.includes(`${CASE_MARKER}_FROM_MOBILE`) ? "mobile" : "desktop"));
    const requestCounts = await Promise.all(
      ["MOBILE", "DESKTOP"].map((side) =>
        countUpstreamRequests(
          {
            lastUserMessageIncludes: [`${CASE_MARKER}_FROM_${side}`],
            excludes: ["Generate a concise title"],
          },
          { afterIndex: fifoStart - 1 },
        ),
      ),
    );
    const requestOrder = (await getUpstreamRequestEvidence({}, { afterIndex: fifoStart - 1 }))
      .map((request) => request.fixtureId)
      .filter((id) => id === "r3-mob-from-mobile" || id === "r3-mob-from-desktop");
    facts.fifo = {
      desktopMobilePromptCount: desktopUsers.filter((t) => t.includes(`${CASE_MARKER}_FROM_MOBILE`))
        .length,
      desktopDesktopPromptCount: desktopUsers.filter((t) =>
        t.includes(`${CASE_MARKER}_FROM_DESKTOP`),
      ).length,
      mobileMobilePromptCount: mobileUsers.filter((text) =>
        text.includes(`${CASE_MARKER}_FROM_MOBILE`),
      ).length,
      mobileDesktopPromptCount: mobileUsers.filter((text) =>
        text.includes(`${CASE_MARKER}_FROM_DESKTOP`),
      ).length,
      desktopSequence: sequence(desktopUsers),
      mobileSequence: sequence(mobileUsers),
      requestCounts,
      requestOrder,
    };
    expect(facts.fifo).toMatchObject({
      desktopMobilePromptCount: 1,
      desktopDesktopPromptCount: 1,
      mobileMobilePromptCount: 1,
      mobileDesktopPromptCount: 1,
      desktopSequence: ["mobile", "desktop"],
      mobileSequence: ["mobile", "desktop"],
      requestCounts: [1, 1],
      requestOrder: ["r3-mob-from-mobile", "r3-mob-from-desktop"],
    });

    // 全新浏览器上下文重新配对（同一链接）：恢复到同一 task，不新增 Host/SSH/Agent。
    await mobileContext.close();
    const second = await newMobileContext();
    mobile = second.page;
    mobileContext = second.context;
    await mobile
      .locator(`[data-testid="${testId(TID_TASK_ITEM, taskA.taskId)}"]`)
      .first()
      .click();
    await mobile
      .getByText("R3_MOBILE_FROM_DESKTOP_REPLY", { exact: false })
      .first()
      .waitFor({ timeout: 60_000 });
    const afterRepair = {
      hosts: (await readHostProcesses()).length,
      ssh: await countRemoteSshSessions(container),
      agents: (await listRemoteAgentProcesses(prepared.config)).length,
    };
    facts.afterRepair = afterRepair;
    // 合同是“不增加”：远端 Agent 可能因空闲回收而减少。
    expect(afterRepair.hosts).toBe(baseline.hosts);
    expect(afterRepair.ssh).toBeLessThanOrEqual(baseline.ssh);
    expect(afterRepair.agents).toBeLessThanOrEqual(baseline.agents);
    await waitForV4Pane(
      (s) => s.sessionId === taskA.taskId,
      `${CASE_MARKER}: 桌面 pane 不在 task A`,
      10_000,
    );
    // RDUX-08：手机网络保持在线，断开真实 SSH Source，验证设备断线投影与手机原地重连。
    const sourceId = parseRemoteWorkspaceIdentity(taskA.identity)?.sourceServerId;
    if (!sourceId) throw new Error(`${CASE_MARKER}: 缺少 Source identity`);
    const unsentDraft = `${CASE_MARKER}_DISCONNECTED_DRAFT`;
    const mobileDraftInput = mobile.locator(`[data-testid="${TID_V4_COMPOSER_INPUT}"]`).first();
    await mobileDraftInput.click();
    await mobile.keyboard.type(unsentDraft);
    await disconnectRemoteSource(sourceId, CASE_MARKER);
    const disconnectedBanner = mobile.getByTestId("remote-conversation-banner");
    await disconnectedBanner.waitFor({ timeout: 30_000 }).catch(async (error: unknown) => {
      await mobile.screenshot({
        path: resolve(artifactDir, "mobile-source-disconnect-failure.png"),
      });
      facts.sourceDisconnectFailure = {
        bannerCount: await disconnectedBanner.count(),
        composerCount: await mobileDraftInput.count(),
      };
      throw error;
    });
    expect(await disconnectedBanner.getAttribute("data-connection-state")).toBe("offline");
    expect(await mobileDraftInput.textContent()).toContain(unsentDraft);
    expect(
      await mobile.locator(`[data-testid="${TID_V4_COMPOSER_SEND}"]`).first().isDisabled(),
    ).toBe(true);
    await mobile.getByTestId("remote-send-unavailable").waitFor();
    // 同一真实手机 Web attachment 下检查设备断线时的深浅主题，保留现有 replayable 链路。
    await mkdir(artifactDir, { recursive: true });
    for (const [theme, label] of [
      ["light", "浅色主题"],
      ["dark", "深色主题"],
    ]) {
      await mobile.getByRole("button", { name: "选择主题", exact: true }).click();
      await mobile.getByRole("menuitemradio", { name: label, exact: true }).click();
      await mobile.waitForFunction(
        (value: string) => document.documentElement.classList.contains(`theme-zai-${value}`),
        theme,
      );
      await mobile.getByRole("menu").waitFor({ state: "hidden" });
      await mobile.screenshot({
        path: resolve(artifactDir, `mobile-disconnected-conversation-${theme}.png`),
        fullPage: true,
        animations: "disabled",
      });
    }
    await disconnectedBanner.getByRole("button", { name: "重新连接", exact: true }).click();
    await disconnectedBanner.waitFor({ state: "hidden", timeout: 60_000 });
    await mobileDraftInput.waitFor().catch(async (error: unknown) => {
      await mobile.screenshot({
        path: resolve(artifactDir, "mobile-source-reconnect-failure.png"),
      });
      facts.sourceReconnectFailure = {
        text: (await mobileText(mobile)).slice(0, 3000),
        historyPage: await mobile.evaluate(() => window.history.state?.zcodeMobilePage ?? null),
      };
      throw error;
    });
    expect(await mobileDraftInput.textContent()).toContain(unsentDraft);
    expect(await getV4QueueItems()).toHaveLength(0);
    expect((await mobileUserRows(mobile)).some((row) => row.text.includes(unsentDraft))).toBe(
      false,
    );
    expect(await countUpstreamRequests({ lastUserMessageIncludes: [unsentDraft] })).toBe(0);
    facts.sourceDisconnect = {
      draftRetained: true,
      sendDisabledWhileOffline: true,
      mobileReconnected: true,
      draftAutoSubmitted: false,
      themes: ["light", "dark"],
    };
    await mobileContext.close();
  });

  it("RDUX-MOBILE-DRAFT 无模型消息：手机保留草稿在深浅主题禁止发送，横幅重连回原项目", async function () {
    this.timeout(15 * 60_000);
    const marker = `${CASE_MARKER}_DRAFT_ONLY`;
    const config = readSSHRuntimeConfig(marker);
    const workspacePath = config.workspacePaths[0];
    await mkdir(artifactDir, { recursive: true });
    await prepareSSHConnectionPage(marker);
    // 上个场景仍停在远程任务；准备函数要求默认项目，不能空等它自动切回。
    // 单独运行时保留正常登录路径；已有侧栏才执行项目导航。
    if (await $('[data-testid="sidebar"]').isDisplayed())
      await openWorkspaceDraftFromSidebar(DEFAULT_WORKSPACE);
    await prepareV4ConversationE2E({ skipProvider: true });
    const requestBaseline = await getUpstreamRequestRecordCount();
    const connected = await connectSSHWorkspace({ caseMarker: marker, config, workspacePath });
    const identity = connected.workspaceIdentity;
    const sourceId = identity ? parseRemoteWorkspaceIdentity(identity)?.sourceServerId : undefined;
    if (!identity || !sourceId) throw new Error(`${marker}: SSH 项目缺少稳定设备身份`);
    const projectId = await $(`[data-project-workspace-identity="${identity}"]`).getAttribute(
      "data-project-id",
    );
    if (!projectId) throw new Error(`${marker}: SSH 项目缺少 projectId`);
    // 项目创建已打开所属 Source 的草稿；全局新建会改为本地未分类任务。
    await browser.execute(() => {
      const actions = (window as Window & { __testActions?: { setLocale(locale: string): void } })
        .__testActions;
      if (!actions) throw new Error("Missing locale actions");
      actions.setLocale("zh-CN");
    });
    await waitForV4Pane((pane) => pane.sessionId === "draft", `${marker}: 桌面不是空草稿`);
    expect(await getV4Messages("user")).toHaveLength(0);

    const pairUrl = await obtainPairUrl();
    const { chromium } = await import("playwright-core");
    // 前一场景仅关闭了 context；覆盖句柄前关闭本轮拥有的旧浏览器，避免泄漏进程。
    await mobileBrowser?.close();
    mobileBrowser = null;
    mobileBrowser = await chromium.launch({ headless: true, executablePath: CHROME });
    const context: import("playwright-core").BrowserContext = await mobileBrowser.newContext({
      viewport: MOBILE_VIEWPORT,
      isMobile: true,
      hasTouch: true,
      locale: "zh-CN",
    });
    const mobile = await context.newPage();
    let phase = "pairing";
    try {
      await openMobilePairingPage(mobile, pairUrl, {
        artifactDir,
        caseMarker: marker,
        phase: "draft-only-pairing",
        readySelector: `[data-project-id="${projectId}"]`,
      });
      await browser.waitUntil(
        async () => (await readDesktopMobileStatus()).includes("手机已连接"),
        { timeout: 60_000 },
      );
      await closeRemoteControlDialog();
      // 手机与桌面共用 ProjectSidebar；通过原项目的新建入口进入空草稿，不发送准备消息。
      const workspaceCard = mobile.locator(`[data-project-id="${projectId}"]`);
      await workspaceCard.waitFor();
      expect(await workspaceCard.count()).toBe(1);
      phase = "open-draft";
      await workspaceCard.getByTestId("virtual-project-create-task").click();
      const composer = mobile.getByTestId(TID_V4_COMPOSER_INPUT).first();
      await composer.waitFor({ timeout: 60_000 });
      const pane = mobile.getByTestId(testId(TID_V4_SESSION_PANE, "workspace-main"));
      expect(await pane.getAttribute("data-session-id")).toBe("draft");
      const unsentDraft = `${marker}_UNSENT`;
      await composer.click();
      await mobile.keyboard.type(unsentDraft);
      await mobile.waitForFunction(
        (text: string) =>
          Object.keys(localStorage).some(
            (key) =>
              key.startsWith("zcode-v4-composer-drafts:v1:") &&
              localStorage.getItem(key)?.includes(text),
          ),
        unsentDraft,
      );
      expect(await mobileUserRows(mobile)).toHaveLength(0);
      // 沿用 RDUX-08-07：手机保持当前聊天 owner，不用首页/浏览器历史制造额外冷态。
      phase = "disconnect-source";
      await disconnectRemoteSource(sourceId, marker);
      await browser.waitUntil(
        async () => !(await readRemoteTabSnapshot(identity)).remoteSessionId,
        { timeout: 30_000 },
      );
      phase = "retained-disconnected-draft";
      const banner = mobile.getByTestId("remote-conversation-banner");
      await banner.waitFor({ timeout: 60_000 });
      expect(await banner.getAttribute("data-connection-state")).toBe("offline");
      expect(await composer.textContent()).toContain(unsentDraft);
      expect(await mobile.getByTestId(TID_V4_COMPOSER_SEND).first().isDisabled()).toBe(true);
      await mobile.getByTestId("remote-send-unavailable").waitFor();
      expect(await composer.evaluate((element) => Boolean(element.closest("[inert]")))).toBe(true);
      for (const [theme, label] of [
        ["light", "浅色主题"],
        ["dark", "深色主题"],
      ] as const) {
        await mobile.getByRole("button", { name: "选择主题", exact: true }).click();
        await mobile.getByRole("menuitemradio", { name: label, exact: true }).click();
        await mobile.waitForFunction(
          (value: string) => document.documentElement.classList.contains(`theme-zai-${value}`),
          theme,
        );
        await mobile.getByRole("menu").waitFor({ state: "hidden" });
        phase = `disconnected-${theme}`;
        expect(await composer.textContent()).toContain(unsentDraft);
        expect(await mobile.getByTestId(TID_V4_COMPOSER_SEND).first().isDisabled()).toBe(true);
        await mobile.screenshot({
          path: resolve(artifactDir, `mobile-retained-draft-${theme}.png`),
          fullPage: true,
          animations: "disabled",
        });
      }
      phase = "reconnect-original-project";
      await banner.getByRole("button", { name: "重新连接", exact: true }).click();
      await banner.waitFor({ state: "hidden", timeout: 120_000 });
      await composer.waitFor({ timeout: 60_000 });
      expect(await composer.textContent()).toContain(unsentDraft);
      expect(await pane.getAttribute("data-session-id")).toBe("draft");
      const restored = await readRemoteTabSnapshot(identity);
      expect(restored.workspaceIdentity).toBe(identity);
      expect(restored.workspacePath).toBe(workspacePath);
      expect(restored.remoteSessionId).toBeTruthy();
      expect(await mobileUserRows(mobile)).toHaveLength(0);
      expect(await getV4Messages("user")).toHaveLength(0);
      expect(await getV4QueueItems()).toHaveLength(0);
      const capturedModelRequests = process.env.E2E_PROVIDER_CAPTURE_PATH?.trim()
        ? await countUpstreamRequests({}, { afterIndex: requestBaseline - 1 })
        : null;
      if (capturedModelRequests !== null) expect(capturedModelRequests).toBe(0);
      facts.draftOnly = {
        identity,
        workspacePath,
        viewport: MOBILE_VIEWPORT,
        themes: ["light", "dark"],
        draftRetained: true,
        noSubmission: true,
        capturedModelRequests,
        scope: "retained draft owner; not cold placeholder, page bootstrap, or streaming gap",
      };
    } catch (error) {
      facts.draftOnlyFailure = {
        phase,
        desktop: await readRemoteTabSnapshot(identity).catch(() => null),
        mobile: await mobile
          .evaluate(
            (ids) => {
              const composer = document.querySelector(`[data-testid="${ids.input}"]`);
              const send = document.querySelector<HTMLButtonElement>(`[data-testid="${ids.send}"]`);
              const banner = document.querySelector('[data-testid="remote-conversation-banner"]');
              return {
                chatVisible: Boolean(document.querySelector('[data-mobile-page="chat"]')),
                bannerState: banner?.getAttribute("data-connection-state") ?? null,
                composerPresent: Boolean(composer),
                composerInert: Boolean(composer?.closest("[inert]")),
                sendDisabled: send?.disabled ?? null,
                unavailableHint: Boolean(
                  document.querySelector('[data-testid="remote-send-unavailable"]'),
                ),
                coldPlaceholder: Boolean(
                  document.querySelector('[data-testid="remote-conversation-unavailable"]'),
                ),
              };
            },
            { input: TID_V4_COMPOSER_INPUT, send: TID_V4_COMPOSER_SEND },
          )
          .catch(() => null),
      };
      await mobile
        .screenshot({
          path: resolve(artifactDir, "mobile-retained-draft-failure.png"),
          fullPage: true,
        })
        .catch(() => undefined);
      throw error;
    } finally {
      await context.close();
    }
  });
});
