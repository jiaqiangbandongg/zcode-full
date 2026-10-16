import { createGenUiPage } from "../../../ui/src/gen-ui/adapters/page.js";
import { registerPluginUiSessionActions } from "../../../ui/src/plugin-ui/hostPrimitives.js";
import type { GenUiPage } from "../../../ui/src/gen-ui/contract.js";
import type { IGenUiService } from "@zcode/services";
import type { GenUiStateChange } from "@zcode/shared/gen-ui";
import type { PluginSandboxPortsEvent } from "@zcode/shared/mcp-apps";
const harness = (window as any).harness;
let portListener: ((event: PluginSandboxPortsEvent) => void) | undefined;
let stateListener: ((event: GenUiStateChange) => void) | undefined;
window.addEventListener("message", (event) => {
  if (event.data?.type === "zcode:plugin-sandbox-ports")
    portListener?.({ ...event.data, port: event.ports[0] });
  if (event.data?.type === "fixture-notification") stateListener?.(event.data.payload);
});
const service = new Proxy(
  {},
  {
    get: (_, key) =>
      key === "onStateChanged"
        ? (fn: typeof stateListener) => {
            stateListener = fn;
            return {
              dispose() {
                stateListener = undefined;
              },
            };
          }
        : (input: unknown) => harness.bridge(key, input),
  },
) as IGenUiService;
void (async () => {
  const config = await harness.config();
  let page: GenUiPage, off: (() => void) | undefined;
  let confirmations = 0,
    messages: unknown[] = [],
    bound = true;
  const target = {
    workspacePath: config.root,
    sessionId: "fixture",
    path: config.path,
    instanceKey: "row:0",
    workspaceIdentity: "ssh:fixture:/workspace",
  };
  const unregister = registerPluginUiSessionActions(target, {
    async sendFollowUp(message) {
      messages.push(message);
    },
  });
  const waitReady = () =>
    new Promise<void>((resolve, reject) => {
      const read = () => {
        const s = page.getSnapshot();
        if (
          s.phase === "ready" &&
          s.groups.length === 2 &&
          s.groups[0]?.controls.length === 4 &&
          s.groups[1]?.controls.length === 2
        ) {
          stop();
          resolve();
        }
        if (s.phase === "error") {
          stop();
          reject(new Error(s.error));
        }
      };
      const stop = page.subscribe(read);
      read();
    });
  async function start() {
    page = createGenUiPage({
      target,
      files: service,
      state: service,
      openExternal: () => {
        throw new Error("External links belong to the React fixture");
      },
      confirm: async (prompt) => {
        confirmations++;
        return prompt;
      },
      platform: {
        supportsRetainedMove: window.zcodePluginSandbox?.supportsRetainedMove,
        copyImage: (request) => window.zcodePluginSandbox!.copyImage!(request),
        getOwnerWebContentsId: () => harness.owner(),
        disposeSandbox: (id, init) => harness.dispose(id, init),
        consumeUserGesture: () => harness.gesture(),
        onPorts(fn) {
          portListener = fn;
          return () => {
            portListener = undefined;
          };
        },
      },
    });
    off = page.bind(document.getElementById("inline")!, false);
    await waitReady();
  }
  Object.assign(window, {
    harnessReady: start(),
    stop: () => page.dispose(),
    copy: () => page.copyImage(),
    switchPage: async (expanded: boolean) => {
      off?.();
      off = page.bind(document.getElementById(expanded ? "expanded" : "inline")!, expanded);
      await new Promise(requestAnimationFrame);
      return page.getSnapshot();
    },
    restore: async () => {
      off?.();
      await page.dispose();
      await start();
    },
    inspect: () => ({ confirmations, messages, bound, snapshot: page.getSnapshot() }),
    setProbeTweaks: (values: Record<string, number>) => page.setTweaks(values),
    unbind: () => {
      unregister();
      bound = false;
    },
    adjust: () =>
      page.setTweaks(
        Object.fromEntries(
          page
            .getSnapshot()
            .groups[0]!.controls.map((control, index) => [
              control.id,
              [35, "#ff0000", false, "compact"][index]!,
            ]),
        ),
      ),
    submit: () => page.submitTweaks({ [page.getSnapshot().groups[0]!.controls[0]!.id]: 35 }),
  });
})();
