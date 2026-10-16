/* eslint-disable max-lines -- Electron capture authority、renderer 消息协议与文件清理属于同一个录制事务，拆开会让 abort/close 状态跨模块竞态。 */
import { randomUUID } from "node:crypto";
import { mkdir, open, rm, writeFile, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  BrowserWindow,
  MessageChannelMain,
  session,
  type MessagePortMain,
  type Session,
  type WebFrameMain,
} from "electron";
import type {
  BrowserWebmRecorderFactoryInput,
  BrowserWebmRecorderFactory,
  BrowserWebmRecorderSession,
} from "./browserVideoRecorder.js";

const RECORDER_PORT_CHANNEL = "zcode-browser-video-recorder:port";
const RECORDER_START_TIMEOUT_MS = 15_000;
const RECORDER_STOP_TIMEOUT_MS = 15_000;

type RecorderRendererMessage =
  | { type: "ready" }
  | { type: "started"; mimeType?: unknown }
  | { type: "chunk"; data?: unknown }
  | { type: "stopped" }
  | { type: "cancelled" }
  | { type: "diagnostic"; message?: unknown }
  | { type: "error"; message?: unknown };

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  let done = false;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  // 某个阶段提前失败时，后续阶段 deferred 仍会被 reject；预挂 catch 防止未进入该阶段的
  // Promise 触发 unhandled rejection，真正的 await 仍会收到原始 rejection。
  void promise.catch(() => undefined);
  return {
    promise,
    resolve: (value) => {
      if (done) return;
      done = true;
      resolvePromise(value);
    },
    reject: (error) => {
      if (done) return;
      done = true;
      rejectPromise(error);
    },
  };
}

function recorderError(message: string): Error {
  return new Error(`Electron WebM recorder failed: ${message}`);
}

function abortError(): DOMException {
  return new DOMException("Browser recording cancelled", "AbortError");
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(recorderError(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function toChunkBuffer(value: unknown): Buffer | null {
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  return Buffer.isBuffer(value) ? value : null;
}

function recorderHtml(): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'">
  </head>
  <body>
    <script>
      (() => {
        const channel = ${JSON.stringify(RECORDER_PORT_CHANNEL)};
        let mediaRecorder = null;
        let mediaStream = null;
        let recordingStream = null;
        let sourceVideo = null;
        let recordingCanvas = null;
        let drawTimer = null;
        let chunkQueue = Promise.resolve();
        let cancelling = false;

        const messageText = (error) => error instanceof Error ? error.message : String(error);
        const stopTracks = () => {
          for (const track of mediaStream?.getTracks?.() ?? []) track.stop();
          for (const track of recordingStream?.getTracks?.() ?? []) track.stop();
          mediaStream = null;
          recordingStream = null;
          if (drawTimer !== null) clearInterval(drawTimer);
          drawTimer = null;
          sourceVideo?.remove();
          recordingCanvas?.remove();
          sourceVideo = null;
          recordingCanvas = null;
        };

        window.addEventListener("message", (event) => {
          if (event.source !== window || event.data !== channel) return;
          const port = event.ports[0];
          if (!port) return;
          port.onmessage = async ({ data }) => {
            if (data?.type === "start") {
              try {
                const candidates = ["video/webm;codecs=vp8", "video/webm"];
                const mimeType = candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate));
                if (!mimeType) throw new Error("Chromium does not support VP8 WebM MediaRecorder");
                const fps = Number(data.fps) || 25;
                const width = Number(data.width);
                const height = Number(data.height);
                if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
                  throw new Error("invalid recorder viewport");
                }
                mediaStream = await navigator.mediaDevices.getDisplayMedia({
                  video: { frameRate: fps },
                  audio: false,
                });
                const [videoTrack] = mediaStream.getVideoTracks();
                port.postMessage({
                  type: "diagnostic",
                  message: "track=" + JSON.stringify({
                    active: mediaStream.active,
                    muted: videoTrack?.muted,
                    readyState: videoTrack?.readyState,
                    settings: videoTrack?.getSettings?.(),
                  }),
                });
                videoTrack?.addEventListener("mute", () => port.postMessage({ type: "diagnostic", message: "track muted" }));
                videoTrack?.addEventListener("unmute", () => port.postMessage({ type: "diagnostic", message: "track unmuted" }));
                videoTrack?.addEventListener("ended", () => port.postMessage({ type: "diagnostic", message: "track ended" }));
                sourceVideo = document.createElement("video");
                sourceVideo.muted = true;
                sourceVideo.playsInline = true;
                sourceVideo.srcObject = mediaStream;
                sourceVideo.style.position = "fixed";
                sourceVideo.style.opacity = "0";
                document.body.append(sourceVideo);
                await sourceVideo.play();

                recordingCanvas = document.createElement("canvas");
                recordingCanvas.width = width;
                recordingCanvas.height = height;
                const context = recordingCanvas.getContext("2d", { alpha: false });
                if (!context) throw new Error("2D canvas recorder is unavailable");
                const drawFrame = () => context.drawImage(sourceVideo, 0, 0, width, height);
                drawFrame();
                drawTimer = setInterval(drawFrame, Math.max(1, Math.round(1000 / fps)));
                recordingStream = recordingCanvas.captureStream(fps);
                mediaRecorder = new MediaRecorder(recordingStream, { mimeType });
                mediaRecorder.addEventListener("dataavailable", (chunkEvent) => {
                  port.postMessage({ type: "diagnostic", message: "dataavailable bytes=" + chunkEvent.data?.size });
                  if (!chunkEvent.data || chunkEvent.data.size === 0) return;
                  chunkQueue = chunkQueue.then(async () => {
                    const bytes = await chunkEvent.data.arrayBuffer();
                    // Bug 原因：DOM MessagePort → Electron MessagePortMain 对 ArrayBuffer transfer
                    // 在部分 Electron 平台会静默丢弃整条消息；让 structured clone 复制分片才能
                    // 保证 dataavailable 与后续 stopped 都按序抵达 main。
                    port.postMessage({ type: "chunk", data: bytes });
                  });
                });
                mediaRecorder.addEventListener("error", (recorderEvent) => {
                  port.postMessage({
                    type: "error",
                    message: messageText(recorderEvent.error ?? "MediaRecorder error"),
                  });
                });
                mediaRecorder.addEventListener("stop", async () => {
                  try {
                    await chunkQueue;
                    port.postMessage({ type: cancelling ? "cancelled" : "stopped" });
                  } catch (error) {
                    port.postMessage({ type: "error", message: messageText(error) });
                  } finally {
                    stopTracks();
                  }
                }, { once: true });
                mediaRecorder.start(1000);
                port.postMessage({ type: "started", mimeType: mediaRecorder.mimeType || mimeType });
              } catch (error) {
                stopTracks();
                port.postMessage({ type: "error", message: messageText(error) });
              }
              return;
            }
            if (data?.type === "stop") {
              if (mediaRecorder?.state === "recording" || mediaRecorder?.state === "paused") {
                mediaRecorder.stop();
              } else {
                port.postMessage({ type: "error", message: "MediaRecorder is not recording" });
              }
              return;
            }
            if (data?.type === "cancel") {
              cancelling = true;
              if (mediaRecorder?.state === "recording" || mediaRecorder?.state === "paused") {
                mediaRecorder.stop();
              } else {
                stopTracks();
                port.postMessage({ type: "cancelled" });
              }
            }
          };
          port.start();
          port.postMessage({ type: "ready" });
        }, { once: true });
      })();
    </script>
  </body>
</html>`;
}

function asTargetFrame(value: unknown): WebFrameMain {
  const frame = value as WebFrameMain | undefined;
  if (!frame || typeof frame.isDestroyed !== "function" || frame.isDestroyed() || frame.detached) {
    throw recorderError("target WebFrameMain is unavailable");
  }
  return frame;
}

function closePort(port: MessagePortMain): void {
  try {
    port.close();
  } catch {
    // 远端 renderer 已退出时 close 允许幂等失败。
  }
}

function closeWindow(window: BrowserWindow): void {
  if (!window.isDestroyed()) window.destroy();
}

function clearDisplayMediaHandler(recorderSession: Session): void {
  try {
    recorderSession.setDisplayMediaRequestHandler(null);
  } catch {
    // session 可能已随 renderer 销毁；handler 没有其它调用方。
  }
}

/**
 * 使用 Electron 自带 Chromium 捕获指定 IAB WebFrameMain，并把 MediaRecorder 的 WebM 分片
 * 顺序写入主进程临时文件。这里不启动外部进程，也不读取 PATH。
 */
export async function createElectronBrowserWebmRecorder(
  input: BrowserWebmRecorderFactoryInput,
  debug?: (message: string) => void,
): Promise<BrowserWebmRecorderSession> {
  if (input.signal.aborted) throw abortError();
  const targetFrame = asTargetFrame(input.targetFrame);
  await mkdir(dirname(input.outputPath), { recursive: true });
  const recorderDocumentPath = join(
    dirname(input.outputPath),
    `.${randomUUID()}-browser-video-recorder.html`,
  );

  const recorderSession = session.fromPartition(`zcode-browser-video-recorder-${randomUUID()}`);
  const recorderWindow = new BrowserWindow({
    show: false,
    width: Math.max(1, input.viewport.width),
    height: Math.max(1, input.viewport.height),
    webPreferences: {
      session: recorderSession,
      preload: join(import.meta.dirname, "../preload/browserVideoRecorder.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      webSecurity: true,
    },
  });
  recorderWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  const { port1: mainPort, port2: rendererPort } = new MessageChannelMain();
  const ready = deferred<void>();
  const started = deferred<void>();
  const stopped = deferred<void>();
  let fileHandle: FileHandle | undefined;
  let writeError: unknown;
  let writeChain = Promise.resolve();
  let closed = false;
  let stopping = false;

  const fail = (error: unknown): void => {
    const normalized = error instanceof Error ? error : recorderError(String(error));
    ready.reject(normalized);
    started.reject(normalized);
    stopped.reject(normalized);
  };
  const onPortMessage = (event: Electron.MessageEvent): void => {
    const message = event.data as RecorderRendererMessage | undefined;
    if (!message || typeof message.type !== "string") return;
    debug?.(`[browser-recording] recorder message type=${message.type}`);
    if (message.type === "ready") {
      ready.resolve();
      return;
    }
    if (message.type === "started") {
      if (message.mimeType !== "video/webm;codecs=vp8" && message.mimeType !== "video/webm") {
        fail(recorderError(`unexpected MediaRecorder MIME type: ${String(message.mimeType)}`));
        return;
      }
      started.resolve();
      return;
    }
    if (message.type === "chunk") {
      const buffer = toChunkBuffer(message.data);
      if (!buffer || buffer.byteLength === 0) {
        debug?.(
          `[browser-recording] ignored empty chunk value=${Object.prototype.toString.call(message.data)}`,
        );
        return;
      }
      debug?.(`[browser-recording] received WebM chunk bytes=${buffer.byteLength}`);
      writeChain = writeChain
        .then(async () => {
          if (!fileHandle) throw recorderError("output file is already closed");
          await fileHandle.write(buffer);
        })
        .catch((error: unknown) => {
          writeError ??= error;
        });
      return;
    }
    if (message.type === "stopped") {
      stopped.resolve();
      return;
    }
    if (message.type === "error") {
      fail(recorderError(typeof message.message === "string" ? message.message : "unknown error"));
      return;
    }
    if (message.type === "diagnostic") {
      debug?.(`[browser-recording] ${String(message.message ?? "")}`);
    }
  };
  mainPort.on("message", onPortMessage);
  mainPort.on("close", () => {
    if (!closed) fail(recorderError("recorder MessagePort closed unexpectedly"));
  });
  mainPort.start();

  const onRendererGone = (_event: unknown, details: { reason?: string }): void => {
    if (!closed) fail(recorderError(`recorder renderer exited: ${details.reason ?? "unknown"}`));
  };
  recorderWindow.webContents.on("render-process-gone", onRendererGone);
  const onConsoleMessage = (
    _event: unknown,
    details: { level?: string; message?: string },
  ): void => {
    debug?.(
      `[browser-recording] recorder console level=${details.level ?? "unknown"} message=${details.message ?? ""}`,
    );
  };
  recorderWindow.webContents.on("console-message", onConsoleMessage);

  const cleanup = async (cancel: boolean): Promise<void> => {
    if (closed) return;
    closed = true;
    input.signal.removeEventListener("abort", onAbort);
    if (cancel) {
      try {
        mainPort.postMessage({ type: "cancel" });
      } catch {
        // renderer/port 已销毁时继续回收 main 资源。
      }
    }
    await writeChain.catch(() => undefined);
    await fileHandle?.close().catch(() => undefined);
    fileHandle = undefined;
    mainPort.removeListener("message", onPortMessage);
    closePort(mainPort);
    closePort(rendererPort);
    clearDisplayMediaHandler(recorderSession);
    recorderWindow.webContents.removeListener("render-process-gone", onRendererGone);
    recorderWindow.webContents.removeListener("console-message", onConsoleMessage);
    closeWindow(recorderWindow);
    await rm(recorderDocumentPath, { force: true }).catch(() => undefined);
  };
  const onAbort = (): void => {
    fail(abortError());
    void cleanup(true);
  };
  input.signal.addEventListener("abort", onAbort, { once: true });

  try {
    await writeFile(recorderDocumentPath, recorderHtml(), { encoding: "utf8", mode: 0o600 });
    recorderSession.setDisplayMediaRequestHandler((request, callback) => {
      if (
        closed ||
        request.frame !== recorderWindow.webContents.mainFrame ||
        !request.videoRequested ||
        request.audioRequested ||
        targetFrame.isDestroyed() ||
        targetFrame.detached
      ) {
        callback({});
        return;
      }
      callback({ video: targetFrame });
    });
    fileHandle = await open(input.outputPath, "w");
    await recorderWindow.loadFile(recorderDocumentPath);
    await rm(recorderDocumentPath, { force: true }).catch(() => undefined);
    recorderWindow.webContents.postMessage(RECORDER_PORT_CHANNEL, null, [rendererPort]);
    await withTimeout(ready.promise, RECORDER_START_TIMEOUT_MS, "recorder renderer did not become ready");
    mainPort.postMessage({
      type: "start",
      fps: input.fps,
      width: input.viewport.width,
      height: input.viewport.height,
    });
    await withTimeout(started.promise, RECORDER_START_TIMEOUT_MS, "MediaRecorder did not start");
  } catch (error) {
    fail(error);
    await cleanup(true);
    throw error;
  }

  const recorder: BrowserWebmRecorderSession = {
    stop: async () => {
      if (closed) throw recorderError("recorder is already closed");
      if (stopping) {
        await withTimeout(stopped.promise, RECORDER_STOP_TIMEOUT_MS, "MediaRecorder did not stop");
        return;
      }
      stopping = true;
      mainPort.postMessage({ type: "stop" });
      try {
        await withTimeout(stopped.promise, RECORDER_STOP_TIMEOUT_MS, "MediaRecorder did not stop");
        await writeChain;
        if (writeError) throw writeError;
      } finally {
        await cleanup(false);
      }
    },
    cancel: () => cleanup(true),
  };
  return recorder;
}

// 保持标准 factory 类型出口，调用方不注入诊断时不会产生按分片日志。
export const defaultElectronBrowserWebmRecorder: BrowserWebmRecorderFactory =
  createElectronBrowserWebmRecorder;
