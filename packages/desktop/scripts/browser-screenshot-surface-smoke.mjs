import { app, BrowserWindow, nativeImage, screen, webContents } from "electron";
import { writeFile } from "node:fs/promises";

const VIEWPORT = { width: 1280, height: 720 };
const INITIAL_SURFACE = { width: 800, height: 450 };
const SENTINEL_SIZE = 96;
const RESULT_PATH = process.env.ZCODE_SCREENSHOT_SMOKE_RESULT_PATH;
const SCALE_FACTOR = process.env.ZCODE_SCREENSHOT_SMOKE_SCALE_FACTOR;
const SUCCESS_RESULT =
  '{"width":1280,"height":720,"periodicRepeat":false,"corners":"distinct"}';

let scaleFactorError;
if (SCALE_FACTOR) {
  const parsedScaleFactor = Number(SCALE_FACTOR);
  if (!Number.isFinite(parsedScaleFactor) || parsedScaleFactor <= 0) {
    scaleFactorError = new Error(
      `ZCODE_SCREENSHOT_SMOKE_SCALE_FACTOR must be a positive number, received ${SCALE_FACTOR}`,
    );
  } else {
    app.commandLine.appendSwitch("force-device-scale-factor", SCALE_FACTOR);
  }
}

function periodicMatchRatio(bitmap, width, height, stride, dx, dy) {
  let compared = 0;
  let equal = 0;
  for (let y = 0; y + dy < height; y += stride) {
    for (let x = 0; x + dx < width; x += stride) {
      const a = (y * width + x) * 4;
      const b = ((y + dy) * width + x + dx) * 4;
      compared += 1;
      if (
        bitmap[a] === bitmap[b] &&
        bitmap[a + 1] === bitmap[b + 1] &&
        bitmap[a + 2] === bitmap[b + 2]
      ) {
        equal += 1;
      }
    }
  }
  return compared === 0 ? 0 : equal / compared;
}

function guestHtml() {
  return `<!doctype html>
<html>
  <head>
    <style>
      html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; }
      body {
        position: relative;
        background:
          linear-gradient(90deg, rgb(11 37 89 / 92%), rgb(217 71 31 / 92%)),
          linear-gradient(180deg, rgb(31 127 211), rgb(239 193 41));
      }
      .sentinel { position: fixed; width: ${SENTINEL_SIZE}px; height: ${SENTINEL_SIZE}px; }
      .top-left { top: 0; left: 0; background: rgb(255 0 0); }
      .top-right { top: 0; right: 0; background: rgb(0 255 0); }
      .bottom-left { bottom: 0; left: 0; background: rgb(0 0 255); }
      .bottom-right { right: 0; bottom: 0; background: rgb(255 255 0); }
    </style>
  </head>
  <body>
    <div class="sentinel top-left"></div>
    <div class="sentinel top-right"></div>
    <div class="sentinel bottom-left"></div>
    <div class="sentinel bottom-right"></div>
  </body>
</html>`;
}

function htmlDataUrl(html) {
  return `data:text/html;base64,${Buffer.from(html).toString("base64")}`;
}

function hostHtml(guestUrl) {
  return `<!doctype html>
<html>
  <head>
    <style>
      html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: rgb(20 20 20); }
      #capture-layer {
        position: absolute;
        top: 0;
        left: 0;
        z-index: 0;
        width: ${INITIAL_SURFACE.width}px;
        height: ${INITIAL_SURFACE.height}px;
        overflow: hidden;
        pointer-events: none;
      }
      #guest { display: block; width: ${INITIAL_SURFACE.width}px; height: ${INITIAL_SURFACE.height}px; }
      #active-cover { position: absolute; inset: 0; z-index: 1; background: rgb(48 48 48); }
    </style>
  </head>
  <body>
    <div id="capture-layer" aria-hidden="true" inert>
      <webview id="guest" src="${guestUrl}"></webview>
    </div>
    <div id="active-cover" aria-hidden="true" inert></div>
    <script>
      const guest = document.querySelector("#guest");
      let guestDomReadyId = 0;
      guest.addEventListener("dom-ready", () => { guestDomReadyId = guest.getWebContentsId(); }, { once: true });
      const nextFrame = () => new Promise(requestAnimationFrame);
      window.waitForGuestDomReady = () => new Promise((resolve) => {
        if (guestDomReadyId) {
          resolve(guestDomReadyId);
          return;
        }
        guest.addEventListener("dom-ready", () => resolve(guest.getWebContentsId()), { once: true });
      });
      window.waitForHistoricalSurface = () => nextFrame();
      window.readStableSurface = async () => {
        await nextFrame();
        const first = guest.getBoundingClientRect();
        await nextFrame();
        const second = guest.getBoundingClientRect();
        return {
          first: { width: Math.round(first.width), height: Math.round(first.height) },
          second: { width: Math.round(second.width), height: Math.round(second.height) },
        };
      };
    </script>
  </body>
</html>`;
}

function rgbaAt(bitmap, width, x, y) {
  const index = (y * width + x) * 4;
  // nativeImage.toBitmap() 在 Windows 采用 Chromium 的 BGRA 顺序，这里统一为 RGBA。
  return [bitmap[index + 2], bitmap[index + 1], bitmap[index], bitmap[index + 3]];
}

function assertColor(name, actual, expected) {
  const tolerance = 2;
  if (actual.some((channel, index) => Math.abs(channel - expected[index]) > tolerance)) {
    throw new Error(`${name} sentinel RGBA mismatch: expected ${expected}, received ${actual}`);
  }
}

function validateScreenshot(png) {
  const image = nativeImage.createFromBuffer(png);
  const { width, height } = image.getSize();
  if (width !== VIEWPORT.width || height !== VIEWPORT.height) {
    throw new Error(
      `screenshot dimensions mismatch: expected ${VIEWPORT.width}x${VIEWPORT.height}, received ${width}x${height}`,
    );
  }

  const bitmap = image.toBitmap();
  const inset = Math.floor(SENTINEL_SIZE / 2);
  assertColor("top-left", rgbaAt(bitmap, width, inset, inset), [255, 0, 0, 255]);
  assertColor("top-right", rgbaAt(bitmap, width, width - inset - 1, inset), [0, 255, 0, 255]);
  assertColor("bottom-left", rgbaAt(bitmap, width, inset, height - inset - 1), [0, 0, 255, 255]);
  assertColor(
    "bottom-right",
    rgbaAt(bitmap, width, width - inset - 1, height - inset - 1),
    [255, 255, 0, 255],
  );

  const horizontalRatio = periodicMatchRatio(bitmap, width, height, 17, 800, 0);
  const verticalRatio = periodicMatchRatio(bitmap, width, height, 17, 0, 450);
  if (horizontalRatio >= 0.95 || verticalRatio >= 0.95) {
    throw new Error(
      `stale tiled surface detected: horizontal=${horizontalRatio.toFixed(4)}, vertical=${verticalRatio.toFixed(4)}`,
    );
  }
}

async function writeSuccess() {
  if (RESULT_PATH) await writeFile(RESULT_PATH, `${SUCCESS_RESULT}\n`, "utf8");
  console.log(SUCCESS_RESULT);
}

async function writeDiagnostic(error) {
  await new Promise((resolve) => process.stderr.write(`${error.stack ?? error}\n`, resolve));
}

async function run() {
  let window;
  let guest;
  let debuggerAttached = false;
  let exitCode = 0;

  try {
    if (scaleFactorError) throw scaleFactorError;
    await app.whenReady();
    const workArea = screen.getPrimaryDisplay().workArea;
    window = new BrowserWindow({
      width: VIEWPORT.width,
      height: VIEWPORT.height,
      useContentSize: true,
      x: Math.max(workArea.x, workArea.x + workArea.width - VIEWPORT.width),
      y: Math.max(workArea.y, workArea.y + workArea.height - VIEWPORT.height),
      show: true,
      focusable: false,
      skipTaskbar: true,
      webPreferences: { webviewTag: true },
    });
    window.showInactive();

    const guestUrl = htmlDataUrl(guestHtml());
    await window.loadURL(htmlDataUrl(hostHtml(guestUrl)));
    const guestId = await window.webContents.executeJavaScript("window.waitForGuestDomReady()", true);
    guest = webContents.fromId(guestId);
    if (!guest) throw new Error(`guest webContents ${guestId} was not found`);

    // 保持 800×450 Fit surface，只用 CDP 把 guest 的逻辑 viewport 改为 1280×720。
    await window.webContents.executeJavaScript("window.waitForHistoricalSurface()", true);
    const surface = await window.webContents.executeJavaScript("window.readStableSurface()", true);
    for (const rect of [surface.first, surface.second]) {
      if (rect.width !== INITIAL_SURFACE.width || rect.height !== INITIAL_SURFACE.height) {
        throw new Error(
          `capture layer did not stabilize at ${INITIAL_SURFACE.width}x${INITIAL_SURFACE.height}: ${JSON.stringify(surface)}`,
        );
      }
    }

    guest.debugger.attach("1.3");
    debuggerAttached = true;
    await guest.debugger.sendCommand("Emulation.setDeviceMetricsOverride", {
      width: VIEWPORT.width,
      height: VIEWPORT.height,
      deviceScaleFactor: 1,
      mobile: false,
      dontSetVisibleSize: true,
    });
    // Bug 原因：Windows 的 CDP Page.captureScreenshot 会把较小 Fit surface 平铺到逻辑
    // viewport；main 直接读取 guest 已合成 surface 不会重复，再归一化到 CSS 尺寸。
    const source = await guest.capturePage();
    const size = source.getSize();
    const resized =
      size.width === VIEWPORT.width && size.height === VIEWPORT.height
        ? source
        : source.resize({ width: VIEWPORT.width, height: VIEWPORT.height, quality: "best" });
    validateScreenshot(resized.toPNG());
    await writeSuccess();
  } catch (error) {
    exitCode = 1;
    await writeDiagnostic(error);
  } finally {
    if (debuggerAttached && guest?.debugger.isAttached()) {
      try {
        guest.debugger.detach();
      } catch (error) {
        exitCode = 1;
        await writeDiagnostic(error);
      }
    }
    if (window && !window.isDestroyed()) window.destroy();
    // window/detach 已完成后显式退出，确保错误退出码不会被 Electron 生命周期回调覆盖。
    app.exit(exitCode);
  }
}

void run();
