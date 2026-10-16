import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { clearAppData } from "../../../helpers/desktop-app.js";
import {
  ELECTRON_WINDOW_RECORDING_CAPTURE_MODE,
  startElectronWindowRecording,
} from "../../../helpers/electron-window-recorder.js";
import {
  V4_MAIN_PANE_ID,
  getV4PaneIds,
  openV4SplitFromSidebar,
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4PromptInPane,
  startNewV4Draft,
  waitForV4Pane,
} from "../../../helpers/v4-conversation.js";

const CASE_NAME = "conversation-session-runtime-communication-performance";

interface PerfLane {
  finalToken: string;
  label: "A" | "B" | "C" | "D";
  paneId: string;
  sessionId: string;
}

describe("通信中性能复现：四分屏 streaming + Agent subagent", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("PERF02: 4 pane 同时经历 Agent tool、child stream 和 parent final stream", async function () {
    this.timeout(420000);

    await prepareV4ConversationE2E();
    const profileOnly = process.env.ZCODE_E2E_PROFILE_ONLY === "1";
    const recording = profileOnly
      ? null
      : await startElectronWindowRecording({
          frameIntervalMs: 250,
          outputPath: resolveArtifactPath(`${CASE_NAME}.webm`),
        });
    const profiler =
      process.env.ZCODE_E2E_PROFILE_STREAMING === "1"
        ? await startRendererCpuProfile()
        : null;

    try {
      const runId = Date.now();
      const lanes = await createRunningPerfSessions(runId);
      await bindRunningSessionsToFourPane(lanes);

      await browser.pause(9000);
      for (const lane of lanes) {
        const snapshot = await waitForV4Pane(
          (current) =>
            current.sessionId === lane.sessionId && current.canStop,
          `pane ${lane.label} 在 child stream 窗口没有保持 running`,
          45000,
          lane.paneId,
        );
        expect(snapshot.sessionId).not.toBe("draft");
      }

      for (const lane of lanes) {
        await waitForV4Pane(
          (snapshot) =>
            snapshot.sessionId === lane.sessionId &&
            snapshot.timelineText.includes(lane.finalToken),
          `pane ${lane.label} 没有出现最终 streaming marker`,
          180000,
          lane.paneId,
        );
      }
    } finally {
      if (profiler) {
        await profiler.stop();
      }
      if (recording) {
        const result = await recording.stop();
        await writeRecordingManifest({
          frameCount: result.frameCount,
          videoPath: result.videoPath,
        });
      }
    }
  });
});

async function createRunningPerfSessions(runId: number): Promise<PerfLane[]> {
  const lanes: PerfLane[] = [];
  for (const label of ["A", "B", "C", "D"] as const) {
    if (lanes.length > 0) {
      await startNewV4Draft();
    }
    await sendV4PromptInPane(
      V4_MAIN_PANE_ID,
      `E2E_RUNTIME_PERF_${label}_${runId}: trigger Agent subagent runtime communication pressure.`,
    );
    const snapshot = await waitForV4Pane(
      (current) =>
        current.sessionId !== "draft" && current.sessionId !== null,
      `session ${label} 没有从 draft 绑定到真实 session`,
      45000,
      V4_MAIN_PANE_ID,
    );
    if (!snapshot.sessionId || snapshot.sessionId === "draft") {
      throw new Error(`session ${label} 缺少真实 sessionId`);
    }
    lanes.push({
      finalToken: `PERF_PARENT_DONE_${label}`,
      label,
      paneId: V4_MAIN_PANE_ID,
      sessionId: snapshot.sessionId,
    });
  }
  return lanes;
}

async function bindRunningSessionsToFourPane(lanes: PerfLane[]) {
  const primaryLane = lanes[0];
  if (!primaryLane || lanes.length !== 4) {
    throw new Error(`四分屏性能用例需要 4 个 session，实际 ${lanes.length} 个`);
  }
  await selectV4TaskById(primaryLane.sessionId);
  primaryLane.paneId = V4_MAIN_PANE_ID;
  for (const lane of lanes.slice(1)) {
    lane.paneId = await openV4SplitFromSidebar(lane.sessionId);
  }
  await browser.waitUntil(async () => (await getV4PaneIds()).length === 4, {
    timeout: 15000,
    timeoutMsg: "四分屏布局没有稳定到 4 个 pane",
  });
  for (const lane of lanes) {
    await waitForV4Pane(
      (snapshot) => snapshot.sessionId === lane.sessionId,
      `pane ${lane.label} 没有绑定到预期 session ${lane.sessionId}`,
      30000,
      lane.paneId,
    );
  }
}

function resolveArtifactPath(fileName: string) {
  return resolve(
    process.env.ZCODE_E2E_ARTIFACT_DIR?.trim() ||
      process.env.CODEX_E2E_ARTIFACT_DIR?.trim() ||
      join(process.cwd(), ".e2e-artifacts", CASE_NAME),
    fileName,
  );
}

async function writeRecordingManifest(input: {
  frameCount: number;
  videoPath: string;
}) {
  const manifestPath = resolveArtifactPath(`${CASE_NAME}.recording.json`);
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        caseName: CASE_NAME,
        frameCount: input.frameCount,
        video_capture_mode: ELECTRON_WINDOW_RECORDING_CAPTURE_MODE,
        videoPath: input.videoPath,
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );
}

async function startRendererCpuProfile() {
  await sendRendererProfilerCommand("start");

  return {
    async stop() {
      const result = await sendRendererProfilerCommand("stop");
      const profilePath = resolveArtifactPath(`${CASE_NAME}.cpuprofile`);
      await mkdir(dirname(profilePath), { recursive: true });
      await writeFile(
        profilePath,
        `${JSON.stringify(result.profile ?? result, null, 2)}\n`,
        "utf-8",
      );
    },
  };
}

async function sendRendererProfilerCommand(command: "start" | "stop") {
  return browser.electron.execute(async (electron, requestedCommand) => {
    const window = electron.BrowserWindow.getAllWindows().find((candidate) => {
      const url = candidate.webContents.getURL();
      return !candidate.isDestroyed() && url.includes("/renderer/index.html");
    });
    if (!window) {
      throw new Error("没有找到可采样的 renderer BrowserWindow");
    }

    const debuggerClient = window.webContents.debugger;
    if (requestedCommand === "start") {
      if (!debuggerClient.isAttached()) {
        debuggerClient.attach("1.3");
      }
      await debuggerClient.sendCommand("Profiler.enable");
      await debuggerClient.sendCommand("Profiler.start");
      return { started: true };
    }

    try {
      return await debuggerClient.sendCommand("Profiler.stop");
    } finally {
      if (debuggerClient.isAttached()) {
        debuggerClient.detach();
      }
    }
  }, command);
}
