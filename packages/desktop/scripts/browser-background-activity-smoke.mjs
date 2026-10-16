import { app, BrowserWindow, webContents } from "electron";

const BACKGROUND_SETTLE_MS = 800;
const ACTIVE_SAMPLE_MS = 400;
const CAPTURING_SAMPLE_MS = 1000;
const CAPTURING_GUEST_MIN_INTERVAL_MS = 200;
// executeJavaScript 自身会短时调度少量帧；timer 计数用于补足后台静止的稳定判据。
const THROTTLED_MAX_FRAMES = 12;
const THROTTLED_MAX_TIMERS = 3;

function wait(timeoutMs) {
  return new Promise((resolve) => setTimeout(resolve, timeoutMs));
}

function activityPageHtml(body = "") {
  return `<!doctype html>
<html>
  <body>
    ${body}
    <script>
      window.activityStats = { frames: 0, timers: 0 };
      const countFrame = () => {
        window.activityStats.frames += 1;
        requestAnimationFrame(countFrame);
      };
      requestAnimationFrame(countFrame);
      setInterval(() => {
        window.activityStats.timers += 1;
      }, 10);
      window.resetActivityStats = () => {
        window.activityStats = { frames: 0, timers: 0 };
      };
      window.readActivityStats = () => ({
        ...window.activityStats,
        visibility: document.visibilityState,
      });
    </script>
  </body>
</html>`;
}

function dataUrl(html) {
  return `data:text/html;base64,${Buffer.from(html).toString("base64")}`;
}

function hostPageHtml(targetGuestUrl, siblingGuestUrl) {
  return activityPageHtml(`
    <webview id="target-guest" src=${JSON.stringify(targetGuestUrl)} style="width: 320px; height: 200px"></webview>
    <webview id="sibling-guest" src=${JSON.stringify(siblingGuestUrl)} style="width: 1px; height: 1px"></webview>
    <script>
      window.waitForGuestIds = () =>
        new Promise((resolve, reject) => {
          let attempts = 100;
          const poll = () => {
            try {
              const targetId = document.getElementById("target-guest").getWebContentsId();
              const siblingId = document.getElementById("sibling-guest").getWebContentsId();
              if (targetId > 0 && siblingId > 0) {
                resolve({ targetId, siblingId });
                return;
              }
            } catch {}
            attempts -= 1;
            if (attempts === 0) {
              reject(new Error("guest webContents did not become ready"));
              return;
            }
            setTimeout(poll, 20);
          };
          poll();
        });
    </script>
  `);
}

async function resetStats(contents) {
  await contents.executeJavaScript("window.resetActivityStats()", true);
}

async function readStats(contents) {
  return await contents.executeJavaScript("window.readActivityStats()", true);
}

async function readAllStats(win, targetGuest, siblingGuest) {
  const [host, target, sibling] = await Promise.all([
    readStats(win.webContents),
    readStats(targetGuest),
    readStats(siblingGuest),
  ]);
  return { host, target, sibling };
}

function assertThrottled(label, stats) {
  if (
    stats.visibility !== "hidden" ||
    stats.frames > THROTTLED_MAX_FRAMES ||
    stats.timers > THROTTLED_MAX_TIMERS
  ) {
    throw new Error(`${label} did not throttle: ${JSON.stringify(stats)}`);
  }
}

function assertActive(label, before, after) {
  const frames = after.frames - before.frames;
  const timers = after.timers - before.timers;
  if (frames < 5 || timers < 10) {
    throw new Error(`${label} did not wake: ${JSON.stringify({ before, after })}`);
  }
  return { frames, timers };
}

function assertRestored(label, before, after) {
  const frames = after.frames - before.frames;
  const timers = after.timers - before.timers;
  if (
    after.visibility !== "hidden" ||
    frames > THROTTLED_MAX_FRAMES ||
    timers > THROTTLED_MAX_TIMERS
  ) {
    throw new Error(`${label} did not restore throttling: ${JSON.stringify({ before, after })}`);
  }
  return { frames, timers };
}

function assertPaced(label, before, after) {
  const frames = after.frames - before.frames;
  const timers = after.timers - before.timers;
  if (frames < 3 || timers < 3) {
    throw new Error(
      `${label} did not advance under paced activity: ${JSON.stringify({ before, after })}`,
    );
  }
  return { frames, timers };
}

function startCapturePump(contents, target, state, fail) {
  let captureCount = 0;
  const capture = async () => {
    captureCount += 1;
    try {
      await contents.capturePage({ x: 0, y: 0, width: 1, height: 1 });
      return true;
    } catch (error) {
      fail(target, error);
      return false;
    }
  };
  const settled = (async () => {
    let pendingStartedAt = Date.now();
    let pending = capture();
    while (pending) {
      const mode = !state.active
        ? "stopped"
        : !state.prepared
          ? "continuous"
          : target === "guest"
            ? "paced"
            : "stopped";
      if (mode === "stopped") {
        await pending;
        pending = undefined;
        continue;
      }
      if (mode === "continuous") {
        const nextStartedAt = Date.now();
        const next = capture();
        if (!(await pending)) {
          await next;
          pending = undefined;
          continue;
        }
        pending = next;
        pendingStartedAt = nextStartedAt;
        continue;
      }
      if (!(await pending)) {
        pending = undefined;
        continue;
      }
      pending = undefined;
      const remainingMs = Math.max(
        0,
        CAPTURING_GUEST_MIN_INTERVAL_MS - (Date.now() - pendingStartedAt),
      );
      if (remainingMs > 0) await wait(remainingMs);
      if (!state.active) continue;
      pendingStartedAt = Date.now();
      pending = capture();
    }
  })();
  return {
    getCaptureCount: () => captureCount,
    settled,
  };
}

function startCaptureActivity(contentsList) {
  const state = { active: true, prepared: false };
  let resolveInvalidated;
  const invalidated = new Promise((resolve) => {
    resolveInvalidated = resolve;
  });
  let failure;
  const fail = (target, error) => {
    if (failure) return;
    failure = new Error(
      `activity capture failed for ${target}: ${error instanceof Error ? error.message : String(error)}`,
    );
    state.active = false;
    resolveInvalidated(failure);
  };
  const pumps = contentsList.map((contents, index) =>
    startCapturePump(contents, index === 0 ? "owner" : "guest", state, fail),
  );
  return {
    getCaptureCounts: () => ({
      owner: pumps[0].getCaptureCount(),
      guest: pumps[1].getCaptureCount(),
    }),
    invalidated,
    markPrepared: () => {
      state.prepared = true;
    },
    ownerSettled: pumps[0].settled,
    release: () => {
      state.active = false;
    },
    settled: Promise.all(pumps.map((pump) => pump.settled)),
  };
}

async function run() {
  let win;
  let targetGuest;
  let siblingGuest;
  let activity;
  let exitCode = 0;
  try {
    await app.whenReady();
    const targetGuestUrl = dataUrl(activityPageHtml());
    const siblingGuestUrl = dataUrl(activityPageHtml());
    win = new BrowserWindow({
      width: 480,
      height: 320,
      show: true,
      webPreferences: {
        webviewTag: true,
      },
    });
    await win.loadURL(dataUrl(hostPageHtml(targetGuestUrl, siblingGuestUrl)));
    const guestIds = await win.webContents.executeJavaScript("window.waitForGuestIds()", true);
    targetGuest = webContents.fromId(guestIds.targetId);
    siblingGuest = webContents.fromId(guestIds.siblingId);
    if (!targetGuest || !siblingGuest) {
      throw new Error(`guest webContents not found: ${JSON.stringify(guestIds)}`);
    }
    if (
      targetGuest.hostWebContents?.id !== win.webContents.id ||
      siblingGuest.hostWebContents?.id !== win.webContents.id
    ) {
      throw new Error("webview guests must belong to the smoke owner BrowserWindow");
    }
    await Promise.all([
      targetGuest.executeJavaScript("document.readyState", true),
      siblingGuest.executeJavaScript("document.readyState", true),
    ]);
    await wait(200);
    win.hide();
    await wait(200);

    if (!win.webContents.getBackgroundThrottling()) {
      throw new Error("BrowserWindow must default to background throttling enabled");
    }
    await Promise.all([
      resetStats(win.webContents),
      resetStats(targetGuest),
      resetStats(siblingGuest),
    ]);
    await wait(BACKGROUND_SETTLE_MS);
    const throttled = await readAllStats(win, targetGuest, siblingGuest);
    assertThrottled("background host renderer", throttled.host);
    assertThrottled("background target webview guest", throttled.target);
    assertThrottled("background sibling webview guest", throttled.sibling);

    activity = startCaptureActivity([win.webContents, targetGuest]);
    await wait(ACTIVE_SAMPLE_MS);
    const active = await readAllStats(win, targetGuest, siblingGuest);
    const activeDelta = {
      host: assertActive("activity host renderer", throttled.host, active.host),
      target: assertActive("activity target webview guest", throttled.target, active.target),
      sibling: assertRestored("activity sibling webview guest", throttled.sibling, active.sibling),
    };

    activity.markPrepared();
    await activity.ownerSettled;
    const capturingBefore = await readAllStats(win, targetGuest, siblingGuest);
    const captureCountsBefore = activity.getCaptureCounts();
    await wait(CAPTURING_SAMPLE_MS);
    const capturingAfter = await readAllStats(win, targetGuest, siblingGuest);
    const captureCountsAfter = activity.getCaptureCounts();
    const capturingDelta = {
      host: assertRestored("prepared host renderer", capturingBefore.host, capturingAfter.host),
      target: assertPaced(
        "prepared target webview guest",
        capturingBefore.target,
        capturingAfter.target,
      ),
      sibling: assertRestored(
        "prepared sibling webview guest",
        capturingBefore.sibling,
        capturingAfter.sibling,
      ),
    };
    const capturingCaptureDelta = {
      owner: captureCountsAfter.owner - captureCountsBefore.owner,
      guest: captureCountsAfter.guest - captureCountsBefore.guest,
    };
    if (capturingCaptureDelta.owner !== 0 || capturingCaptureDelta.guest > 7) {
      throw new Error(
        `prepared activity capture rate was not bounded: ${JSON.stringify(capturingCaptureDelta)}`,
      );
    }

    activity.release();
    await activity.settled;
    await Promise.all([
      resetStats(win.webContents),
      resetStats(targetGuest),
      resetStats(siblingGuest),
    ]);
    await wait(BACKGROUND_SETTLE_MS);
    const restored = await readAllStats(win, targetGuest, siblingGuest);
    assertThrottled("restored host renderer", restored.host);
    assertThrottled("restored target webview guest", restored.target);
    assertThrottled("restored sibling webview guest", restored.sibling);
    if (!win.webContents.getBackgroundThrottling()) {
      throw new Error("activity lease must not disable BrowserWindow background throttling");
    }

    const injectedFailure = startCaptureActivity([
      {
        capturePage: () => Promise.reject(new Error("injected capture failure")),
      },
      {
        capturePage: () => Promise.resolve(),
      },
    ]);
    const failure = await Promise.race([
      injectedFailure.invalidated,
      wait(500).then(() => undefined),
    ]);
    if (!(failure instanceof Error) || !failure.message.includes("injected capture failure")) {
      throw new Error("activity capture failure was not surfaced");
    }
    await injectedFailure.settled;
    const failureCaptureCounts = injectedFailure.getCaptureCounts();
    if (failureCaptureCounts.owner > 2 || failureCaptureCounts.guest > 2) {
      throw new Error(
        `activity capture failure did not stop pumps: ${JSON.stringify(failureCaptureCounts)}`,
      );
    }

    console.log(
      JSON.stringify({
        throttled,
        activeDelta,
        capturingDelta,
        capturingCaptureDelta,
        failureCaptureCounts,
        restored,
      }),
    );
  } catch (error) {
    exitCode = 1;
    console.error(error);
  } finally {
    activity?.release();
    await activity?.settled.catch(() => undefined);
    if (win && !win.isDestroyed()) win.destroy();
    app.exit(exitCode);
  }
}

void run();
