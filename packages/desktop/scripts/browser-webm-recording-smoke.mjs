import { app, BrowserWindow, webContents } from "electron";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createElectronBrowserWebmRecorder } from "../out/main/browserWebmRecorder.js";

const OUTPUT_PATH = process.env.ZCODE_WEBM_SMOKE_OUTPUT_PATH;
const CAPTURE_MS = Number(process.env.ZCODE_WEBM_SMOKE_CAPTURE_MS) || 1_500;

function htmlDataUrl(html) {
  return `data:text/html;base64,${Buffer.from(html).toString("base64")}`;
}

function targetHtml() {
  return `<!doctype html>
<html>
  <head>
    <style>
      html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; }
      body { background: #172554; }
      #box {
        position: absolute;
        top: 120px;
        left: 80px;
        width: 160px;
        height: 160px;
        background: #22d3ee;
        animation: travel 1s linear infinite alternate;
      }
      @keyframes travel { to { transform: translateX(720px) rotate(180deg); background: #f97316; } }
    </style>
  </head>
  <body><div id="box"></div></body>
</html>`;
}

function hostHtml(targetUrl) {
  return `<!doctype html>
<html>
  <head>
    <style>
      html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; }
      #guest { display: block; width: 1280px; height: 720px; }
    </style>
  </head>
  <body>
    <webview id="guest" src="${targetUrl}"></webview>
    <script>
      const guest = document.querySelector("#guest");
      window.guestReady = new Promise((resolve) => {
        guest.addEventListener("dom-ready", () => resolve(guest.getWebContentsId()), { once: true });
      });
    </script>
  </body>
</html>`;
}

async function validatePlayback(root, outputPath) {
  const validationHtmlPath = join(root, "validate.html");
  await writeFile(
    validationHtmlPath,
    `<!doctype html><video id="video" src="${pathToFileURL(outputPath).href}" muted></video>`,
    "utf8",
  );
  const validationWindow = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
  try {
    await validationWindow.loadFile(validationHtmlPath);
    return await validationWindow.webContents.executeJavaScript(`(async () => {
      const video = document.querySelector("#video");
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("WebM playback metadata timeout")), 10000);
        video.addEventListener("loadedmetadata", () => { clearTimeout(timer); resolve(); }, { once: true });
        video.addEventListener("error", () => {
          clearTimeout(timer);
          reject(new Error(video.error?.message || "WebM playback failed"));
        }, { once: true });
        video.load();
      });
      const width = video.videoWidth;
      const height = video.videoHeight;

      const seek = (time) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("WebM seek timeout at " + time)), 10000);
        video.addEventListener("seeked", () => { clearTimeout(timer); resolve(); }, { once: true });
        video.currentTime = time;
      });

      // MediaRecorder 的流式 WebM 不写 Duration 头，video.duration 是 Infinity。
      // seek 到超大时间点让 Chromium 定位真实末尾，再读回可播放时长。
      await seek(1e7);
      const durationSeconds = video.currentTime;
      if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
        throw new Error("WebM has no seekable duration: " + String(durationSeconds));
      }

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      const grabFrame = async (time) => {
        await seek(Math.max(0, Math.min(time, durationSeconds - 0.01)));
        context.drawImage(video, 0, 0, width, height);
        return context.getImageData(0, 0, width, height).data;
      };

      const samples = [
        await grabFrame(durationSeconds * 0.1),
        await grabFrame(durationSeconds * 0.5),
        await grabFrame(durationSeconds * 0.9),
      ];
      const pixels = width * height;
      const changedRatio = (left, right) => {
        let changed = 0;
        for (let index = 0; index < left.length; index += 4) {
          const delta = Math.abs(left[index] - right[index])
            + Math.abs(left[index + 1] - right[index + 1])
            + Math.abs(left[index + 2] - right[index + 2]);
          if (delta > 24) changed += 1;
        }
        return changed / pixels;
      };
      const changedPixelRatio = Math.max(
        changedRatio(samples[0], samples[1]),
        changedRatio(samples[1], samples[2]),
        changedRatio(samples[0], samples[2]),
      );
      let litPixels = 0;
      for (let index = 0; index < samples[1].length; index += 4) {
        if (samples[1][index] + samples[1][index + 1] + samples[1][index + 2] > 24) litPixels += 1;
      }

      // 实际解码帧率：统计一段真实播放里的 video frame callback 次数。
      await seek(0);
      let sampledFrames = 0;
      let sampledMs = 0;
      await new Promise((resolve) => {
        const startedAt = performance.now();
        const finish = () => { sampledMs = performance.now() - startedAt; resolve(); };
        const onFrame = () => {
          sampledFrames += 1;
          if (performance.now() - startedAt >= 1000) { finish(); return; }
          video.requestVideoFrameCallback(onFrame);
        };
        video.requestVideoFrameCallback(onFrame);
        setTimeout(finish, 4000);
        void video.play();
      });
      video.pause();

      return {
        width,
        height,
        durationSeconds,
        changedPixelRatio,
        litPixelRatio: litPixels / pixels,
        sampledFrames,
        sampledFps: sampledMs > 0 ? sampledFrames / (sampledMs / 1000) : 0,
      };
    })()`);
  } finally {
    if (!validationWindow.isDestroyed()) validationWindow.destroy();
  }
}

async function run() {
  let hostWindow;
  let root;
  let exitCode = 0;
  try {
    await app.whenReady();
    root = await mkdtemp(join(tmpdir(), "zcode-browser-webm-smoke-"));
    const outputPath = OUTPUT_PATH || join(root, "recording.webm");
    hostWindow = new BrowserWindow({
      show: true,
      focusable: false,
      skipTaskbar: true,
      width: 1280,
      height: 720,
      useContentSize: true,
      webPreferences: { webviewTag: true, backgroundThrottling: false },
    });
    hostWindow.showInactive();
    await hostWindow.loadURL(htmlDataUrl(hostHtml(htmlDataUrl(targetHtml()))));
    const guestId = await hostWindow.webContents.executeJavaScript("window.guestReady", true);
    const guest = webContents.fromId(guestId);
    if (!guest) throw new Error(`target guest ${guestId} was not found`);
    await hostWindow.webContents.executeJavaScript(
      "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
    );
    guest.debugger.attach("1.3");
    await guest.debugger.sendCommand("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 720,
      deviceScaleFactor: 1,
      mobile: false,
      dontSetVisibleSize: true,
    });
    const hostRect = await hostWindow.webContents.executeJavaScript(
      `(() => { const r = document.querySelector("#guest").getBoundingClientRect(); return { width: r.width, height: r.height, dpr: devicePixelRatio }; })()`,
    );
    const guestViewport = await guest.executeJavaScript(
      `({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio })`,
    );
    process.stderr.write(
      `[browser-recording] smoke target guestId=${guestId} frame=${guest.mainFrame.processId}:${guest.mainFrame.routingId} hostRect=${JSON.stringify(hostRect)} guestViewport=${JSON.stringify(guestViewport)}\n`,
    );

    const controller = new AbortController();
    const recorder = await createElectronBrowserWebmRecorder(
      {
        outputPath,
        targetFrame: guest.mainFrame,
        viewport: { width: 1280, height: 720 },
        fps: 25,
        signal: controller.signal,
      },
      (message) => process.stderr.write(`${message}\n`),
    );
    const captureStartedAt = Date.now();
    await new Promise((resolve) => setTimeout(resolve, CAPTURE_MS));
    await recorder.stop();
    const capturedMs = Date.now() - captureStartedAt;

    const info = await stat(outputPath);
    const header = (await readFile(outputPath)).subarray(0, 4).toString("hex");
    if (info.size <= 4 || header !== "1a45dfa3") {
      throw new Error(`invalid WebM artifact: size=${info.size}, header=${header}`);
    }
    const playback = await validatePlayback(root, outputPath);
    if (playback.width !== 1280 || playback.height !== 720) {
      throw new Error(`WebM dimensions mismatch: ${JSON.stringify(playback)}`);
    }
    // 时长必须来自真实容器，而不是 main 侧推算：偏离取景 wall clock 太多说明丢帧或提前截断。
    const durationMs = playback.durationSeconds * 1000;
    if (durationMs < capturedMs * 0.5 || durationMs > capturedMs * 1.5 + 500) {
      throw new Error(
        `WebM duration ${durationMs.toFixed(0)}ms is not consistent with ${capturedMs}ms of capture`,
      );
    }
    // 只验证尺寸会让全黑或全静止的录制也通过；这里要求画面真的在动且不是黑屏。
    if (playback.changedPixelRatio < 0.02) {
      throw new Error(
        `recorded frames are static: changedPixelRatio=${playback.changedPixelRatio.toFixed(4)}`,
      );
    }
    if (playback.litPixelRatio < 0.5) {
      throw new Error(`recorded frames are mostly black: litPixelRatio=${playback.litPixelRatio.toFixed(4)}`);
    }
    if (playback.sampledFps < 8) {
      throw new Error(
        `decoded frame rate too low: ${playback.sampledFps.toFixed(1)}fps over ${playback.sampledFrames} frames`,
      );
    }
    console.log(JSON.stringify({ ok: true, path: outputPath, size: info.size, capturedMs, ...playback }));
  } catch (error) {
    exitCode = 1;
    await new Promise((resolve) => process.stderr.write(`${error.stack ?? error}\n`, resolve));
  } finally {
    for (const contents of webContents.getAllWebContents()) {
      if (contents.getType() === "webview" && contents.debugger.isAttached()) {
        try {
          contents.debugger.detach();
        } catch {
          // smoke 已进入退出清理，不覆盖更早的验证错误。
        }
      }
    }
    if (hostWindow && !hostWindow.isDestroyed()) hostWindow.destroy();
    if (root && !OUTPUT_PATH) await rm(root, { recursive: true, force: true });
    process.exitCode = exitCode;
    app.exit(exitCode);
  }
}

void run();
