/* eslint-disable max-lines -- APC01-APC12 共用真实 Host stat、Browser/Preview Pane 与 cold-resume fixture。 */
import { copyFile, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TID_BROWSER_ADDRESS_INPUT, TID_BROWSER_WEBVIEW, TID_PREVIEW_PANE } from "@zcode/shared";
import { clearAppData, DEFAULT_WORKSPACE } from "../helpers/desktop-app.js";
import { restartIntoWorkspacePreservingProfile } from "../helpers/model-provider-restart.js";
import {
  clickV4Stop,
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4Prompt,
  startNewV4Draft,
  switchV4Mode,
  waitForV4AssistantMessageContaining,
  waitForV4Pane,
} from "../helpers/v4-conversation.js";

const CASE_MARKER = "E2E_ASSISTANT_PREVIEW_CARDS";
const CASE_RELATIVE_ROOT = "assistant-preview-e2e";
const CASE_ROOT = join(DEFAULT_WORKSPACE, CASE_RELATIVE_ROOT);
const OFFICE_FIXTURE_ROOT = fileURLToPath(
  new URL(
    "../fixtures/fs/conversation-session/conversation-session-assistant-preview-cards/",
    import.meta.url,
  ),
);
const STREAM_URL = "http://localhost:41789/assistant-preview-stream";

const SOURCE_HTML_RELATIVE_PATH = `${CASE_RELATIVE_ROOT}/本轮 输出/index 页面.html`;
const SOURCE_MARKDOWN_RELATIVE_PATH = `${CASE_RELATIVE_ROOT}/本轮 输出/说明 文档.md`;
const SOURCE_HTML_PATH = join(DEFAULT_WORKSPACE, SOURCE_HTML_RELATIVE_PATH);

const OFFICE_FILES = [
  { fixture: "sample.docx", name: "项目 简介.docx" },
  { fixture: "sample.xlsx", name: "年度 总结.xlsx" },
  { fixture: "sample.pptx", name: "产品 路线.pptx" },
  { fixture: "sample.pdf", name: "审计 报告.pdf" },
] as const;
const MEDIA_FILES = ["生成 视频.mp4", "生成 音频.wav"] as const;

interface PreviewCardSnapshot {
  text: string;
  title: string;
}

let fixtureServer: Server | null = null;
let fixtureRootUrl = "";

describe("Assistant Preview Cards E2E", () => {
  before(async () => {
    fixtureServer = createFixtureServer();
    fixtureRootUrl = await listen(fixtureServer);
  });

  afterEach(async () => {
    await closeSidePanes();
    await rm(CASE_ROOT, { recursive: true, force: true });
  });

  after(async () => {
    await closeServer(fixtureServer);
    fixtureServer = null;
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("APC01/APC04: completed localhost URL 去重并打开真实 Browser 页面", async () => {
    await prepareCase();
    const marker = `${CASE_MARKER}_LOCAL_URL`;
    await sendV4Prompt(
      `${marker}: reply with the same local preview URL more than once. E2E_BROWSER_FIXTURE_URL:${fixtureRootUrl}`,
    );
    await waitForCompleted(`${marker}_DONE`);

    await waitForPreviewCards(["APC Local Preview"]);
    await clickPreviewCard("APC Local Preview");
    await waitForBrowserSurface(fixtureRootUrl, "APC01_LOCAL_URL_PAGE");
  }).timeout(180_000);

  it("APC02: interrupted turn 在 URL 已到达后 Stop，卡片只在终态出现", async () => {
    await prepareCase();
    const marker = `${CASE_MARKER}_INTERRUPTED`;
    await sendV4Prompt(`${marker}: keep streaming after publishing ${STREAM_URL}.`);
    await waitForV4AssistantMessageContaining(`${marker}_EARLY`, 60_000);
    expect(await readPreviewCards()).toEqual([]);

    await clickV4Stop();
    await waitForV4Pane(
      (snapshot) => !snapshot.canStop && snapshot.timelineText.includes(`${marker}_EARLY`),
      "APC02 Stop 后 turn 没有进入 interrupted 终态",
      60_000,
    );
    await waitForPreviewCards(["assistant-preview-stream"]);
  }).timeout(180_000);

  it("APC03: streaming 期间不显示卡片，complete 后显示", async () => {
    await prepareCase();
    const marker = `${CASE_MARKER}_STREAMING`;
    await sendV4Prompt(`${marker}: stream ${STREAM_URL} before the final marker.`);
    await waitForV4AssistantMessageContaining(`${marker}_EARLY`, 60_000);
    expect(await readPreviewCards()).toEqual([]);

    await waitForCompleted(`${marker}_DONE`);
    await waitForPreviewCards(["assistant-preview-stream"]);
  }).timeout(180_000);

  it("APC04: localhost 与本轮 HTML 同时出现时按现有业务规则抑制 HTML", async () => {
    await prepareCase({ yolo: true });
    const marker = `${CASE_MARKER}_LOCAL_SUPPRESSES_HTML`;
    await sendV4Prompt(
      `${marker}: create ${SOURCE_HTML_RELATIVE_PATH}, then mention it with E2E_BROWSER_FIXTURE_URL:${fixtureRootUrl}.`,
    );
    await waitForCompleted(`${marker}_DONE`);

    await waitForPreviewCards(["APC Local Only"]);
    await expectPreviewCardMissing(basename(SOURCE_HTML_RELATIVE_PATH));
  }).timeout(180_000);

  it("APC06/APC07: source gate、Office 自动打开 PPTX", async () => {
    await prepareCase();
    await materializeOfficeFixtures();
    await materializeStaleSourceFiles();
    const marker = `${CASE_MARKER}_OFFICE`;
    await sendV4Prompt(`${marker}_PPTX: report the prepared Office files and one missing PDF.`);
    await waitForCompleted(`${marker}_PPTX_DONE`);

    const officeTitles = [...OFFICE_FILES].reverse().map((item) => item.name);
    await waitForPreviewCards(officeTitles);
    await expectPreviewCardMissing("旧 页面.html");
    await expectPreviewCardMissing("旧 说明.md");
    await expectPreviewCardMissing("不存在.pdf");
    await waitForPreviewRenderer("产品 路线.pptx", "pptx");
  }).timeout(240_000);

  it("APC12: 独立音频消息打开原生 audio 播放器", async () => {
    await prepareCase();
    await materializeMediaFixtures();
    const marker = `${CASE_MARKER}_OFFICE_AUDIO`;
    await sendV4Prompt(`${marker}: report the prepared audio file only.`);
    await waitForCompleted(`${marker}_DONE`);
    await waitForPreviewCards(["生成 音频.wav"]);
    const logSnapshot = await snapshotDesktopRuntimeLogs();
    await clickPreviewCard("生成 音频.wav");
    await waitForPreviewRenderer("生成 音频.wav", "audio");
    await assertLocalMediaPreviewLogs(logSnapshot);
  }).timeout(180_000);

  it("APC12: 独立视频消息打开并保持 media 节点", async () => {
    await prepareCase();
    await materializeMediaFixtures();
    const marker = `${CASE_MARKER}_OFFICE_VIDEO`;
    await sendV4Prompt(`${marker}: report the prepared video file only.`);
    await waitForCompleted(`${marker}_DONE`);
    await waitForPreviewCards(["生成 视频.mp4"]);
    const logSnapshot = await snapshotDesktopRuntimeLogs();
    await clickPreviewCard("生成 视频.mp4");
    await waitForPreviewRenderer("生成 视频.mp4", "video");
    const mediaUrl = await browser.execute(
      () => document.querySelector<HTMLVideoElement>("video[controls]")?.currentSrc ?? "",
    );
    expect(mediaUrl).not.toBe("");
    expect(new URL(mediaUrl).protocol).toBe("zcode-media:");
    await assertPreviewVideoSurvivesResizeAndFullscreen();
    await assertLocalMediaPreviewLogs(logSnapshot);
  }).timeout(180_000);

  it("APC08: 最多显示 10 张，并且前 15 个不足时不从第 16 个以后回填", async () => {
    await prepareCase();
    await materializeBoundFiles();

    const maxMarker = `${CASE_MARKER}_MAX_TEN`;
    await sendV4Prompt(`${maxMarker}: list the twelve prepared max-bound PDF paths in order.`);
    await waitForCompleted(`${maxMarker}_DONE`);
    await waitForPreviewCards(
      Array.from({ length: 10 }, (_, index) => `max-${String(12 - index).padStart(2, "0")}.pdf`),
    );
    await expectPreviewCardMissing("max-02.pdf");
    await expectPreviewCardMissing("max-01.pdf");

    await prepareCase();
    await materializeBoundFiles();
    const noFillMarker = `${CASE_MARKER}_NO_BACKFILL`;
    await sendV4Prompt(
      `${noFillMarker}: list all sixteen no-backfill PDF paths in ascending order.`,
    );
    await waitForCompleted(`${noFillMarker}_DONE`);
    await waitForPreviewCards(
      Array.from({ length: 9 }, (_, index) => `nofill-${String(16 - index).padStart(2, "0")}.pdf`),
    );
    await expectPreviewCardMissing("nofill-01.pdf");
  }).timeout(240_000);

  it("APC05/APC09/APC11: 当前轮 HTML/Markdown 逆序展示、打开，收起偏好在切换会话和 cold resume 后保留", async () => {
    await prepareCase({ yolo: true });
    const marker = `${CASE_MARKER}_SOURCE_AND_COLD`;
    await sendV4Prompt(
      `${marker}: create ${SOURCE_HTML_RELATIVE_PATH} and ${SOURCE_MARKDOWN_RELATIVE_PATH}, then report both.`,
    );
    await waitForCompleted(`${marker}_DONE`);
    const targetSession = await waitForBoundSession(marker);

    const expectedTitles = [
      basename(SOURCE_MARKDOWN_RELATIVE_PATH),
      basename(SOURCE_HTML_RELATIVE_PATH),
    ];
    await waitForPreviewCards(expectedTitles);
    await assertSourcePreviewTargets();
    await assertLocalHtmlExternalOpen();

    await clickPreviewCard(basename(SOURCE_MARKDOWN_RELATIVE_PATH));
    await waitForPreviewRenderer(basename(SOURCE_MARKDOWN_RELATIVE_PATH), "markdown");
    await waitForSidePaneExpanded(true);
    await clickSidePaneToggle();
    await waitForSidePaneExpanded(false);

    await startNewV4Draft();
    const parkingMarker = `${CASE_MARKER}_PARKING`;
    await sendV4Prompt(`${parkingMarker}: complete a parking task before cold resume.`);
    await waitForCompleted(`${parkingMarker}_DONE`);
    const parkingSession = await waitForBoundSession(parkingMarker);
    expect(parkingSession).not.toBe(targetSession);

    await selectV4TaskById(targetSession, 60_000);
    await waitForV4Pane(
      (snapshot) =>
        snapshot.sessionId === targetSession && snapshot.timelineText.includes(`${marker}_DONE`),
      `APC11 切回目标 session ${targetSession} 后没有恢复对话`,
      90_000,
    );
    await waitForPreviewCards(expectedTitles, 90_000);
    await waitForSidePaneExpanded(false);
    await clickPreviewCard(basename(SOURCE_MARKDOWN_RELATIVE_PATH));
    await waitForPreviewRenderer(basename(SOURCE_MARKDOWN_RELATIVE_PATH), "markdown");
    await waitForSidePaneExpanded(true);
    await closeSidePanes();

    await restartIntoWorkspacePreservingProfile();
    await selectV4TaskById(targetSession, 60_000);
    await waitForV4Pane(
      (snapshot) =>
        snapshot.sessionId === targetSession && snapshot.timelineText.includes(`${marker}_DONE`),
      `APC09 cold resume 后没有恢复目标 session ${targetSession}`,
      90_000,
    );
    await waitForPreviewCards(expectedTitles, 90_000);
    await assertSourcePreviewTargets();
  }).timeout(360_000);
});

async function prepareCase(options: { yolo?: boolean } = {}) {
  await prepareV4ConversationE2E();
  if (options.yolo) {
    await switchV4Mode("yolo");
  }
  await rm(CASE_ROOT, { recursive: true, force: true });
  await mkdir(CASE_ROOT, { recursive: true });
}

async function waitForCompleted(marker: string) {
  await waitForV4AssistantMessageContaining(marker, 90_000);
  await waitForV4Pane(
    (snapshot) => !snapshot.canStop && snapshot.timelineText.includes(marker),
    `Assistant Preview Cards turn 没有完成: ${marker}`,
    90_000,
  );
}

async function waitForBoundSession(marker: string): Promise<string> {
  const snapshot = await waitForV4Pane(
    (current) =>
      current.sessionId !== null &&
      current.sessionId !== "draft" &&
      !current.canStop &&
      current.timelineText.includes(marker),
    `Assistant Preview Cards 缺少已绑定 session: ${marker}`,
    60_000,
  );
  if (!snapshot.sessionId || snapshot.sessionId === "draft") {
    throw new Error(`Assistant Preview Cards 得到无效 sessionId: ${snapshot.sessionId ?? "null"}`);
  }
  return snapshot.sessionId;
}

async function readPreviewCards(
  expectedTitles: readonly string[] = [],
): Promise<PreviewCardSnapshot[]> {
  return browser.execute(
    (titles) => {
      const openLabels = new Set(["Open", "打开"]);
      return Array.from(
        document.querySelectorAll<HTMLElement>('[data-zcode-stream-animate="true"]'),
      )
        .filter((row) =>
          Array.from(row.querySelectorAll<HTMLButtonElement>("button")).some((button) =>
            openLabels.has((button.textContent ?? "").trim()),
          ),
        )
        .map((row) => {
          const text = row.innerText.replace(/\u00a0/g, " ").trim();
          const title = titles.find((candidate) => text.includes(candidate)) ?? "";
          return { text, title };
        });
    },
    [...expectedTitles],
  );
}

async function waitForPreviewCards(expectedTitles: readonly string[], timeout = 60_000) {
  let latest: PreviewCardSnapshot[] = [];
  await browser.waitUntil(
    async () => {
      latest = await readPreviewCards(expectedTitles);
      return (
        latest.length === expectedTitles.length &&
        latest.every((card, index) => card.title === expectedTitles[index])
      );
    },
    {
      timeout,
      timeoutMsg: `预览卡片没有按预期收敛: expected=${JSON.stringify(expectedTitles)} latest=${JSON.stringify(latest)}`,
    },
  );
}

async function expectPreviewCardMissing(title: string) {
  const cards = await readPreviewCards([title]);
  expect(cards.some((card) => card.title === title)).toBe(false);
}

async function clickPreviewCard(title: string) {
  const result = await browser.execute((expectedTitle) => {
    const openLabels = new Set(["Open", "打开"]);
    const row = Array.from(
      document.querySelectorAll<HTMLElement>('[data-zcode-stream-animate="true"]'),
    ).find((candidate) => candidate.innerText.includes(expectedTitle));
    const button = Array.from(row?.querySelectorAll<HTMLButtonElement>("button") ?? []).find(
      (candidate) => openLabels.has((candidate.textContent ?? "").trim()),
    );
    button?.click();
    return { clicked: Boolean(button), disabled: Boolean(button?.disabled) };
  }, title);
  expect(result.clicked).toBe(true);
  expect(result.disabled).toBe(false);
}

async function assertLocalHtmlExternalOpen() {
  const openPath = await browser.electron.mock("shell", "openPath");
  await openPath.mockResolvedValue("");
  try {
    const expectedTitle = basename(SOURCE_HTML_RELATIVE_PATH);
    const rows = await browser.$$('[data-zcode-stream-animate="true"]');
    const row = (await rows.map(async (candidate) => ({
      candidate,
      text: await candidate.getText(),
    }))).find(({ text }) => text.includes(expectedTitle))?.candidate;
    expect(row).toBeDefined();
    const trigger = await row?.$('button[aria-label="Choose app"], button[aria-label="选择打开方式"]');
    expect(trigger).toBeDefined();
    await trigger?.click();

    await browser.waitUntil(
      async () => {
        const labels = new Set(["Open in browser", "在浏览器中打开"]);
        const items = await browser.$$('[role="menuitem"]');
        const item = (await items.map(async (candidate) => ({
          candidate,
          text: await candidate.getText(),
        }))).find(({ text }) => labels.has(text.trim()))?.candidate;
        if (!item) return false;
        await item.click();
        return true;
      },
      { timeout: 10_000, timeoutMsg: "本地 HTML 卡片没有显示外部浏览器入口" },
    );

    await browser.waitUntil(
      async () => {
        try {
          await expect(openPath).toHaveBeenCalledWith(await realpath(SOURCE_HTML_PATH));
          return true;
        } catch {
          return false;
        }
      },
      { timeout: 10_000, timeoutMsg: "本地 HTML 没有通过 shell.openPath 打开" },
    );
  } finally {
    await browser.electron.restoreAllMocks();
  }
}

async function clickSidePaneToggle() {
  const clicked = await browser.execute(() => {
    const button = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
      (candidate) =>
        ["收起侧边面板", "Collapse side pane", "展开侧边面板", "Expand side pane"].includes(
          candidate.getAttribute("aria-label") ?? "",
        ),
    );
    button?.click();
    return Boolean(button);
  });
  expect(clicked).toBe(true);
}

async function waitForSidePaneExpanded(expectedExpanded: boolean) {
  let latestLabel = "";
  await browser.waitUntil(
    async () => {
      latestLabel = await browser.execute(() => {
        const button = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
          (candidate) =>
            ["收起侧边面板", "Collapse side pane", "展开侧边面板", "Expand side pane"].includes(
              candidate.getAttribute("aria-label") ?? "",
            ),
        );
        return button?.getAttribute("aria-label") ?? "";
      });
      const isExpanded = ["收起侧边面板", "Collapse side pane"].includes(latestLabel);
      return isExpanded === expectedExpanded;
    },
    {
      timeout: 15_000,
      timeoutMsg: `side pane 展开状态不符合预期: expected=${expectedExpanded}, label=${latestLabel}`,
    },
  );
}

async function waitForBrowserSurface(expectedUrl: string, bodyMarker: string) {
  let latest = { address: "", webContentsId: 0 };
  await browser.waitUntil(
    async () => {
      latest = await browser.execute(
        (addressTestId, webviewTestId) => {
          const address = document.querySelector<HTMLInputElement>(
            `[data-testid="${addressTestId}"]`,
          );
          const webview = document.querySelector<HTMLElement>(`[data-testid="${webviewTestId}"]`) as
            | (HTMLElement & { getWebContentsId?: () => number })
            | null;
          return {
            address: address?.value ?? "",
            webContentsId: webview?.getWebContentsId?.() ?? 0,
          };
        },
        TID_BROWSER_ADDRESS_INPUT,
        TID_BROWSER_WEBVIEW,
      );
      return latest.webContentsId > 0 && new URL(latest.address).href === new URL(expectedUrl).href;
    },
    {
      timeout: 60_000,
      timeoutMsg: `Browser Pane 没有打开目标 URL: ${JSON.stringify(latest)}`,
    },
  );

  let latestBody = "";
  await browser.waitUntil(
    async () => {
      latestBody = await browser.electron.execute(async (electron, webContentsId) => {
        const contents = electron.webContents.fromId(webContentsId);
        if (!contents || contents.isDestroyed()) return "";
        return contents.executeJavaScript("document.body?.innerText ?? ''");
      }, latest.webContentsId);
      return latestBody.includes(bodyMarker);
    },
    {
      timeout: 60_000,
      timeoutMsg: `Browser webview 没有加载页面 marker ${bodyMarker}: ${latestBody}`,
    },
  );
}

async function waitForPreviewRenderer(
  filename: string,
  renderer: "docx" | "excel" | "pptx" | "pdf" | "markdown" | "audio" | "video",
) {
  let latest = { hasError: false, header: "", ready: false, text: "" };
  await browser.waitUntil(
    async () => {
      latest = await browser.execute(
        (previewTestId, expectedFilename, expectedRenderer) => {
          const pane = document.querySelector<HTMLElement>(`[data-testid="${previewTestId}"]`);
          const text = (pane?.innerText ?? "").replace(/\u00a0/g, " ");
          const hasError = Boolean(pane?.querySelector('[role="alert"]'));
          let ready = false;
          if (expectedRenderer === "docx" || expectedRenderer === "excel") {
            ready = Boolean(
              pane?.querySelector(`[data-office-preview-kind="${expectedRenderer}"]`),
            );
          } else if (expectedRenderer === "pptx") {
            ready = Boolean(pane?.querySelector("aside[aria-label] button[aria-label]"));
          } else if (expectedRenderer === "pdf") {
            ready = Boolean(pane?.querySelector(".react-pdf__Document .react-pdf__Page"));
          } else if (expectedRenderer === "audio") {
            ready = Boolean(pane?.querySelector("audio[controls]"));
          } else if (expectedRenderer === "video") {
            ready = Boolean(pane?.querySelector("video[controls][playsinline]"));
          } else {
            ready = text.includes("APC05 Markdown renderer marker");
          }
          return {
            hasError,
            header: text.split("\n")[0] ?? "",
            ready,
            text,
          };
        },
        TID_PREVIEW_PANE,
        filename,
        renderer,
      );
      return !latest.hasError && latest.text.includes(filename) && latest.ready;
    },
    {
      timeout: 90_000,
      timeoutMsg: `Preview Pane renderer 没有就绪: ${filename}/${renderer}; latest=${JSON.stringify(latest)}`,
    },
  );
}

async function assertPreviewVideoSurvivesResizeAndFullscreen() {
  const videoReady = await browser.execute(() => {
    const video = document.querySelector<HTMLVideoElement>("video[controls][playsinline]");
    if (!video) return false;
    const probeWindow = window as Window & { __zcodePreviewVideo?: HTMLVideoElement };
    probeWindow.__zcodePreviewVideo = video;
    window.dispatchEvent(new Event("resize"));
    return true;
  });
  expect(videoReady).toBe(true);

  // resize settling 的 state update 应该已经完成；媒体节点不能被替换或卸载。
  await browser.pause(80);
  const sameVideoAfterResize = await browser.execute(() => {
    const probeWindow = window as Window & { __zcodePreviewVideo?: HTMLVideoElement };
    return (
      document.querySelector<HTMLVideoElement>("video[controls][playsinline]") ===
      probeWindow.__zcodePreviewVideo
    );
  });
  expect(sameVideoAfterResize).toBe(true);

  const fullscreenResult = await browser.executeAsync((done) => {
    const video = document.querySelector<HTMLVideoElement>("video[controls][playsinline]");
    if (!video?.requestFullscreen) {
      done("unsupported");
      return;
    }
    const finish = () => {
      document.removeEventListener("fullscreenchange", finish);
      done(document.fullscreenElement === video ? "entered" : "not-entered");
    };
    document.addEventListener("fullscreenchange", finish, { once: true });
    void video.requestFullscreen().catch(() => {
      document.removeEventListener("fullscreenchange", finish);
      done("unsupported");
    });
  });
  if (fullscreenResult === "entered") {
    await browser.pause(500);
    const sameVideoInFullscreen = await browser.execute(() => {
      const probeWindow = window as Window & { __zcodePreviewVideo?: HTMLVideoElement };
      const video = document.querySelector<HTMLVideoElement>("video[controls][playsinline]");
      return video === probeWindow.__zcodePreviewVideo && document.fullscreenElement === video;
    });
    expect(sameVideoInFullscreen).toBe(true);
    await browser.execute(() => {
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    });
  }
}

async function assertSourcePreviewTargets() {
  await clickPreviewCard(basename(SOURCE_MARKDOWN_RELATIVE_PATH));
  await waitForPreviewRenderer(basename(SOURCE_MARKDOWN_RELATIVE_PATH), "markdown");
  await closePreviewPane();

  await clickPreviewCard(basename(SOURCE_HTML_RELATIVE_PATH));
  await waitForBrowserSurface(new URL(`file://${SOURCE_HTML_PATH}`).href, "APC05_HTML_PAGE");
  await closeSidePanes();
}

async function materializeOfficeFixtures() {
  const officeRoot = join(CASE_ROOT, "office");
  await mkdir(officeRoot, { recursive: true });
  await Promise.all(
    OFFICE_FILES.map((item) =>
      copyFile(join(OFFICE_FIXTURE_ROOT, item.fixture), join(officeRoot, item.name)),
    ),
  );
}

async function materializeMediaFixtures() {
  const mediaRoot = join(CASE_ROOT, "media");
  await mkdir(mediaRoot, { recursive: true });
  const videoFixture = await readFile(
    new URL("../fixtures/media/sample-video.mp4", import.meta.url),
  );
  const largeVideo = Buffer.concat([
    videoFixture,
    Buffer.alloc(Math.max(0, 8 * 1024 * 1024 + 1 - videoFixture.length)),
  ]);
  const wav = Buffer.alloc(45);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(37, 4);
  wav.write("WAVEfmt ", 8, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8_000, 24);
  wav.writeUInt32LE(8_000, 28);
  wav.writeUInt16LE(1, 32);
  wav.writeUInt16LE(8, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(1, 40);
  wav[44] = 128;
  await Promise.all([
    writeFile(join(mediaRoot, "生成 视频.mp4"), largeVideo),
    writeFile(join(mediaRoot, "生成 音频.wav"), wav),
  ]);
  expect((await stat(join(mediaRoot, "生成 视频.mp4"))).size).toBeGreaterThan(8 * 1024 * 1024);
}

async function materializeStaleSourceFiles() {
  const staleRoot = join(CASE_ROOT, "stale");
  await mkdir(staleRoot, { recursive: true });
  await Promise.all([
    writeFile(join(staleRoot, "旧 页面.html"), "<p>stale html</p>", "utf8"),
    writeFile(join(staleRoot, "旧 说明.md"), "stale markdown", "utf8"),
  ]);
}

async function assertLocalMediaPreviewLogs(snapshot: Map<string, number>): Promise<void> {
  const runtimeLogDir = process.env.ZCODE_E2E_RUNTIME_LOG_DIR?.trim();
  if (!runtimeLogDir) {
    throw new Error("当前 E2E worker 没有配置 desktop runtime log 目录");
  }

  let desktopLogs = "";
  await browser.waitUntil(
    async () => {
      desktopLogs = await readDesktopRuntimeLogsSince(runtimeLogDir, snapshot);
      return (
        desktopLogs.includes("[rpc:call] media-preview.prepare OK") &&
        desktopLogs.includes("local media preview path authorization OK")
      );
    },
    {
      timeout: 30_000,
      interval: 250,
      timeoutMsg: `本地媒体预览日志没有完成: ${desktopLogs}`,
    },
  );
  expect(desktopLogs).not.toContain("[rpc:call] file.readMediaPreview");
}

async function snapshotDesktopRuntimeLogs(): Promise<Map<string, number>> {
  const runtimeLogDir = process.env.ZCODE_E2E_RUNTIME_LOG_DIR?.trim();
  if (!runtimeLogDir) {
    throw new Error("当前 E2E worker 没有配置 desktop runtime log 目录");
  }
  const entries = await readdir(runtimeLogDir, { withFileTypes: true }).catch(() => []);
  const snapshot = new Map<string, number>();
  await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".log"))
      .map(async (entry) => {
        snapshot.set(entry.name, (await stat(join(runtimeLogDir, entry.name))).size);
      }),
  );
  return snapshot;
}

async function readDesktopRuntimeLogsSince(
  runtimeLogDir: string,
  snapshot: Map<string, number>,
): Promise<string> {
  const entries = await readdir(runtimeLogDir, { withFileTypes: true }).catch(() => []);
  const logFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".log"))
    .map((entry) => entry.name)
    .sort();
  const contents = await Promise.all(
    logFiles.map(async (fileName) => {
      const content = await readFile(join(runtimeLogDir, fileName));
      const offset = Math.min(snapshot.get(fileName) ?? 0, content.byteLength);
      return content.subarray(offset).toString("utf8");
    }),
  );
  return contents.join("\n");
}

async function materializeBoundFiles() {
  const boundsRoot = join(CASE_ROOT, "bounds");
  await mkdir(boundsRoot, { recursive: true });
  await Promise.all([
    ...Array.from({ length: 12 }, (_, index) =>
      writeFile(
        join(boundsRoot, `max-${String(index + 1).padStart(2, "0")}.pdf`),
        "exists",
        "utf8",
      ),
    ),
    writeFile(join(boundsRoot, "nofill-01.pdf"), "excluded existing candidate", "utf8"),
    ...Array.from({ length: 9 }, (_, index) =>
      writeFile(
        join(boundsRoot, `nofill-${String(index + 8).padStart(2, "0")}.pdf`),
        "exists",
        "utf8",
      ),
    ),
  ]);
}

async function closePreviewPane() {
  // Bug 根因：PreviewPane 自身没有关闭按钮，关闭动作属于外层 side-pane tab。
  // 必须关闭当前激活 tab 并等待旧 pane 卸载，否则下一次点击卡片仍会看到旧 renderer。
  const closed = await browser.execute(() => {
    const activeTab = document.querySelector<HTMLElement>("[data-side-pane-tab-id][data-active]");
    const closeButton = activeTab?.querySelector<HTMLButtonElement>("button");
    closeButton?.click();
    return Boolean(closeButton);
  });
  expect(closed).toBe(true);
  await browser.waitUntil(
    async () =>
      !(await browser.execute(
        (previewTestId) => Boolean(document.querySelector(`[data-testid="${previewTestId}"]`)),
        TID_PREVIEW_PANE,
      )),
    {
      timeout: 10_000,
      timeoutMsg: "Preview Pane 点击关闭后没有卸载",
    },
  );
}

async function closeSidePanes() {
  await browser.waitUntil(
    async () =>
      browser.execute(() => {
        const tab =
          document.querySelector<HTMLElement>("[data-side-pane-tab-id][data-active]") ??
          document.querySelector<HTMLElement>("[data-side-pane-tab-id]");
        const closeButton = tab?.querySelector<HTMLButtonElement>("button");
        if (!closeButton) return true;
        closeButton.click();
        return false;
      }),
    {
      interval: 100,
      timeout: 10_000,
      timeoutMsg: "Assistant Preview Cards 清理 side pane tabs 超时",
    },
  );
}

function createFixtureServer(): Server {
  return createServer((_request, response) => {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(
      "<!doctype html><html><head><title>APC01 Local Preview</title></head><body>APC01_LOCAL_URL_PAGE</body></html>",
    );
  });
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}/assistant-preview`;
}

async function closeServer(server: Server | null) {
  if (!server) return;
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
}
