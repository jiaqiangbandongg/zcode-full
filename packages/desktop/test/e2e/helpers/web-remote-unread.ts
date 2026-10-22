import { once } from "node:events";
import { createServer } from "node:http";
import type { BrowserContext, Page } from "playwright-core";
import { parseWebRemoteControlAppPayload, type WebRemoteControlStatus } from "@zcode/shared";
import { parseWebRemoteControlRelayV2IncomingMessage } from "@zcode/shared/web-remote-relay";

/** 只延迟真实回包和丢弃重申；不改 epoch、Reporter 或 Main 查看事实。 */
export async function replayStaleBootstrapAfterReconnect(context: BrowserContext) {
  let held: string | Buffer | undefined;
  let oldEpoch: string | undefined;
  const evidence = { replayed: false, epochChanged: false, droppedRequests: 0, staleReports: 0 };
  await context.routeWebSocket(/\/api\/v1\/remote\/ws2(?:\?|$)/u, (route) => {
    const server = route.connectToServer();
    route.onMessage((message) => {
      const frame = JSON.parse(String(message)) as { type?: string; payload?: unknown };
      const payload = parseWebRemoteControlAppPayload(frame.payload);
      if (payload?.zcode_type === "mobile-task-view-update" && payload.epoch === oldEpoch)
        evidence.staleReports += 1;
      server.send(message);
    });
    server.onMessage(async (message) => {
      const frame = parseWebRemoteControlRelayV2IncomingMessage(JSON.parse(String(message)));
      const payload =
        frame?.type === "data" ? parseWebRemoteControlAppPayload(frame.payload) : null;
      if (payload?.zcode_type === "mobile-task-view-request") {
        evidence.droppedRequests += 1;
        return;
      }
      if (payload?.zcode_type === "bootstrap-response") {
        if (!held) {
          held = message;
          oldEpoch = payload.result.mobileTaskViewEpoch;
          // 旧请求仍在 Web 等待时真实断连；新连接必须从自身 bootstrap 恢复查看资格。
          await server.close();
          await route.close();
          return;
        }
        evidence.epochChanged = Boolean(
          payload.result.mobileTaskViewEpoch && payload.result.mobileTaskViewEpoch !== oldEpoch,
        );
      }
      route.send(message);
      if (
        held &&
        !evidence.replayed &&
        (frame?.type === "auth_ack" || frame?.type === "pair_status_ack") &&
        frame.pair_status === "matched"
      ) {
        evidence.replayed = true;
        route.send(held);
      }
    });
  });
  return evidence;
}

export interface UnreadTaskAddress {
  taskId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

/** 只读实际 Main 查看事实，不调用 Web reporter，也不把最后导航当成正在查看。 */
export async function readMobileTaskView() {
  return browser.execute(async () => {
    const bridge = (
      window as Window & {
        zcode?: { getWebRemoteControlStatus(): Promise<WebRemoteControlStatus> };
      }
    ).zcode;
    if (!bridge) throw new Error("MRO03 desktop platform missing");
    const status = await bridge.getWebRemoteControlStatus();
    return {
      connected: status.mobileConnected,
      view:
        (status as WebRemoteControlStatus & { mobileTaskView?: UnreadTaskAddress | null })
          .mobileTaskView ?? null,
    };
  });
}

export async function waitMobileTaskView(address: UnreadTaskAddress | null) {
  await browser.waitUntil(
    async () => {
      const { view } = await readMobileTaskView();
      if (!address) return view === null;
      return (
        view?.taskId === address.taskId &&
        view.workspacePath === address.workspacePath &&
        (view.workspaceIdentity ?? null) === (address.workspaceIdentity ?? null)
      );
    },
    {
      timeout: 30_000,
      interval: 100,
      timeoutMsg: `MRO03 actual Web view did not converge: ${JSON.stringify(address)}`,
    },
  );
}

export async function showMobileTaskHome(page: Page) {
  const back = page.getByRole("button", { name: /^(返回任务首页|Back to task home)$/u });
  if (await back.isVisible()) await back.click();
  await page.getByTestId("sidebar").waitFor();
}

/** 配对凭据只经内存 loopback receiver，不进入 WebDriver 返回值与日志。 */
export async function obtainUnreadPairingUrl(): Promise<string> {
  let receive!: (url: string) => void;
  const pairing = new Promise<string>((resolveUrl) => {
    receive = resolveUrl;
  });
  const receiver = createServer(async (request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    if (request.method === "OPTIONS") {
      response.end();
      return;
    }
    let url = "";
    for await (const chunk of request) url += String(chunk);
    receive(url);
    response.end();
  });
  receiver.listen(0, "127.0.0.1");
  await once(receiver, "listening");
  const address = receiver.address();
  if (!address || typeof address === "string") throw new Error("MRO03 pair receiver unavailable");
  try {
    await browser.execute((port) => {
      const target = window as Window & { __mro03RestoreClipboard?: () => void };
      const original = navigator.clipboard.writeText.bind(navigator.clipboard);
      target.__mro03RestoreClipboard = () => {
        navigator.clipboard.writeText = original;
      };
      navigator.clipboard.writeText = async (url) => {
        await fetch(`http://127.0.0.1:${port}`, { method: "POST", body: url });
      };
    }, address.port);
    await $(
      'button[aria-label="移动端远程控制"], button[aria-label="Mobile remote control"]',
    ).click();
    await browser.waitUntil(
      () =>
        browser.execute(() => {
          const copy = Array.from(
            document.querySelectorAll<HTMLButtonElement>(
              '[data-testid="web-remote-control-dialog-scroll"] button',
            ),
          ).find(
            (button) => /^(复制链接|Copy link)$/u.test(button.innerText.trim()) && !button.disabled,
          );
          copy?.click();
          return Boolean(copy);
        }),
      { timeout: 60_000, timeoutMsg: "MRO03 pairing link unavailable" },
    );
    const url = await pairing;
    if (new URL(url).origin !== "http://127.0.0.1:5173")
      throw new Error("MRO03 requires loopback Web frontend");
    await browser.keys("Escape");
    return url;
  } finally {
    await browser.execute(() => {
      const target = window as Window & { __mro03RestoreClipboard?: () => void };
      target.__mro03RestoreClipboard?.();
      delete target.__mro03RestoreClipboard;
    });
    await new Promise<void>((done, reject) =>
      receiver.close((error) => (error ? reject(error) : done())),
    );
  }
}
