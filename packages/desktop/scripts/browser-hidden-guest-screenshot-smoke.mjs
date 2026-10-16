import { app, BrowserWindow, webContents } from "electron";

const CAPTURE_TIMEOUT_MS = 4_000;
const ACTIVITY_CAPTURE_RECT = { x: 0, y: 0, width: 1, height: 1 };

function wait(timeoutMs) {
  return new Promise((resolve) => setTimeout(resolve, timeoutMs));
}

function dataUrl(html) {
  return `data:text/html;base64,${Buffer.from(html).toString("base64")}`;
}

function hostPageHtml(guestUrl) {
  return `<!doctype html>
<html>
  <body>
    <script>
      window.createHiddenGuest = () => {
        const guest = document.createElement("webview");
        guest.src = ${JSON.stringify(guestUrl)};
        guest.style.cssText = "display:block;width:320px;height:200px";
        document.body.appendChild(guest);
      };
    </script>
  </body>
</html>`;
}

function captureWithTimeout(contents, rect, label) {
  return Promise.race([
    contents.capturePage(rect),
    wait(CAPTURE_TIMEOUT_MS).then(() => {
      throw new Error(`${label} timed out after ${CAPTURE_TIMEOUT_MS}ms`);
    }),
  ]);
}

async function run() {
  let win;
  let originalOpacity;
  let taskbarHidden = false;
  let exitCode = 0;
  try {
    await app.whenReady();
    if (process.platform !== "darwin" && process.platform !== "win32") {
      console.log(
        JSON.stringify({
          skipped: `transparent hidden-window bootstrap is unsupported on ${process.platform}`,
        }),
      );
      return;
    }

    const guestUrl = dataUrl(`<!doctype html>
<html>
  <body style="margin:0;background:rgb(20,90,170);width:100vw;height:100vh"></body>
</html>`);
    win = new BrowserWindow({
      width: 480,
      height: 320,
      show: true,
      webPreferences: { webviewTag: true },
    });
    await win.loadURL(dataUrl(hostPageHtml(guestUrl)));
    win.hide();
    await wait(200);

    const attached = new Promise((resolve) => {
      win.webContents.once("did-attach-webview", (_event, guest) => resolve(guest.id));
    });
    await win.webContents.executeJavaScript("window.createHiddenGuest()", true);
    const guestId = await Promise.race([
      attached,
      wait(CAPTURE_TIMEOUT_MS).then(() => {
        throw new Error("hidden-born guest did not attach");
      }),
    ]);
    const guest = webContents.fromId(guestId);
    if (!guest || guest.hostWebContents?.id !== win.webContents.id) {
      throw new Error(`hidden-born guest owner mismatch: ${guestId}`);
    }
    await guest.executeJavaScript("document.readyState", true);

    originalOpacity = win.getOpacity();
    if (process.platform === "win32") {
      win.setSkipTaskbar(true);
      taskbarHidden = true;
    }
    win.setOpacity(0);
    win.showInactive();
    if (win.isFocused()) {
      throw new Error("transparent bootstrap unexpectedly focused the owner window");
    }

    // 与 controller 一致：先给 Viz 一个有界 presentation grace，再为 owner/guest
    // 各建立两份重叠 capturer；同一 turn 立即 capture 会触发 UnknownVizError。
    await wait(100);
    const bootstrapImages = await Promise.all([
      captureWithTimeout(win.webContents, ACTIVITY_CAPTURE_RECT, "owner bootstrap capture A"),
      captureWithTimeout(win.webContents, ACTIVITY_CAPTURE_RECT, "owner bootstrap capture B"),
      captureWithTimeout(guest, ACTIVITY_CAPTURE_RECT, "guest bootstrap capture A"),
      captureWithTimeout(guest, ACTIVITY_CAPTURE_RECT, "guest bootstrap capture B"),
    ]);
    if (bootstrapImages.some((image) => image.isEmpty())) {
      throw new Error(
        `hidden-born bootstrap returned empty image: ${JSON.stringify(
          bootstrapImages.map((image) => image.getSize()),
        )}`,
      );
    }

    // 真实产品在 renderer 两帧稳定 Ready 后执行 markPrepared；模拟该边界再恢复 hidden。
    await wait(50);
    win.hide();
    win.setOpacity(originalOpacity);
    if (taskbarHidden) {
      win.setSkipTaskbar(false);
      taskbarHidden = false;
    }
    const finalImage = await captureWithTimeout(
      guest,
      { x: 0, y: 0, width: 320, height: 200 },
      "hidden-born final capture",
    );
    if (finalImage.isEmpty()) {
      throw new Error("hidden-born final capture remained empty after bootstrap cleanup");
    }
    if (win.isVisible() || win.isFocused() || win.getOpacity() !== originalOpacity) {
      throw new Error(
        `transparent bootstrap did not restore window state: ${JSON.stringify({
          focused: win.isFocused(),
          opacity: win.getOpacity(),
          originalOpacity,
          visible: win.isVisible(),
        })}`,
      );
    }

    console.log(
      JSON.stringify({
        bootstrapSizes: bootstrapImages.map((image) => image.getSize()),
        finalSize: finalImage.getSize(),
        focused: win.isFocused(),
        opacity: win.getOpacity(),
        platform: process.platform,
        taskbarRestored: !taskbarHidden,
        visible: win.isVisible(),
      }),
    );
  } catch (error) {
    exitCode = 1;
    console.error(error);
  } finally {
    if (win && !win.isDestroyed()) {
      if (win.isVisible()) win.hide();
      if (originalOpacity !== undefined) win.setOpacity(originalOpacity);
      if (taskbarHidden) win.setSkipTaskbar(false);
      win.destroy();
    }
    app.exit(exitCode);
  }
}

void run();
