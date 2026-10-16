import { registerPluginUiSessionActions } from "../../../ui/src/plugin-ui/adapters/pluginUiSessionActions.js";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { ServiceProvider } from "../../../ui/src/hooks/useServices.js";
import { PlatformProvider } from "../../../ui/src/hooks/usePlatform.js";
import { usePluginUiHost } from "../../../ui/src/plugin-ui/adapters/usePluginUiHost.js";
import { PluginUiCard } from "../../../ui/src/plugin-ui/components/PluginUiCard.js";
import { PluginUiSidePaneView } from "../../../ui/src/plugin-ui/components/PluginUiSidePane.js";
import { pluginUiPages } from "../../../ui/src/plugin-ui/adapters/pluginUiPageRegistry.js";
import { getPluginUiWidgetState } from "../../../ui/src/plugin-ui/app/pluginUiWidgetStateStore.js";
import { RowsFixture } from "./rows-renderer.js";
import type {
  UsePluginUiHostInput,
  UsePluginUiHostResult,
} from "../../../ui/src/plugin-ui/adapters/pluginUiHostTypes.js";
const harness = (window as any).harness;
const ready = Promise.withResolvers<void>();
(window as any).harnessReady = ready.promise;
const drained = new Set<() => void>();
const channels = new Map<string, Set<(value: any) => void>>();
const emit = (name: string, value: unknown) => {
  for (const handler of channels.get(name) ?? []) handler(value);
};
const subscribe = (name: string, handler: (value: any) => void) => {
  const set = channels.get(name) ?? new Set();
  channels.set(name, set);
  set.add(handler);
  return {
    dispose: () => {
      set.delete(handler);
      for (const notify of drained) notify();
    },
  };
};
window.addEventListener("message", (event) => {
  if (event.data?.type === "fixture-notification")
    emit(event.data.payload.kind, event.data.payload.value);
  if (event.data?.type === "zcode:plugin-sandbox-ports")
    emit("ports", { ...event.data, port: event.ports[0] });
});
const proxy = (send: (method: string, p: unknown) => Promise<unknown>) =>
  new Proxy({}, { get: (_, method) => (p: unknown) => send(String(method), p) });
const agent = {
  ...Object.fromEntries(
    [
      "helloConversationV4",
      "initializeConversationV4",
      "subscribeConversationV4",
      "unsubscribeConversationV4",
      "resyncConversationV4",
    ].map((method) => [method, (p: unknown) => harness.v4(method, p)]),
  ),
  onDynamicConversationFrame: () => (handler: any) => subscribe("frame", handler),
  onDynamicLocalTtftFacts: () => (handler: any) => subscribe("ttft", handler),
  onAgentRuntimeRestarted: (handler: any) => subscribe("restart", handler),
  onAgentRuntimeLifecycle: (handler: any) => subscribe("lifecycle", handler),
};
const services = {
  zcodeAgentService: agent,
  zcodeTaskService: { onDynamicWorkspaceEvent: () => (handler: any) => subscribe("task", handler) },
  pluginUiBridgeService: proxy(harness.bridge),
  pluginUiSamplingService: proxy(harness.bridge),
  pluginUiAppToolsService: proxy(harness.appTools),
};
const platform = {
  pluginSandbox: {
    getOwnerWebContentsId: () => harness.owner(),
    disposeSandbox: (id: string, init: number) => harness.dispose(id, init),
    consumeUserGesture: async () => false,
    onPorts(handler: any) {
      const listener = subscribe("ports", handler);
      return () => listener.dispose();
    },
  },
};
let current: UsePluginUiHostResult;
let renderState: (next: {
  inline: boolean;
  sidebar: boolean;
  sequence?: number;
  remote?: boolean;
}) => void;
let config: any;
const phases: string[] = [];
const deadlines = new Set<() => void>();
const realSetTimeout = window.setTimeout.bind(window),
  realClearTimeout = window.clearTimeout.bind(window);
const fakeIds = new Map<number, () => void>();
let nextTimer = -1;
// 只控制产品的五分钟保活期限；握手、teardown、v4 keep-warm 仍用真实完成事件/时钟。
window.setTimeout = ((run: () => void, ms: number, ...args: any[]) => {
  if (ms !== 300_000) return realSetTimeout(run, ms, ...args);
  const id = nextTimer--;
  deadlines.add(run);
  fakeIds.set(id, run);
  return id;
}) as typeof window.setTimeout;
window.clearTimeout = ((id: number) => {
  const run = fakeIds.get(id);
  if (run) {
    deadlines.delete(run);
    fakeIds.delete(id);
  } else realClearTimeout(id);
}) as typeof window.clearTimeout;

function Anchor({
  side,
  enabled,
  sequence,
  remote,
}: {
  side: boolean;
  enabled: boolean;
  sequence?: number;
  remote?: boolean;
}) {
  const input: UsePluginUiHostInput = {
    ...config,
    scope: { ...config.scope, ...(remote ? { remoteSessionId: "fixture-remote" } : {}) },
    theme: config.theme ?? "light",
    locale: config.locale ?? "en",
    displayMode: side ? "fullscreen" : "inline",
    width: config.width ?? 400,
    hostVersion: "managed-fixture",
    toolInput: sequence === undefined ? undefined : { sequence },
    toolResult:
      sequence === undefined ? undefined : { content: [], structuredContent: { sequence } },
    toolCallId: `feed-${sequence}`,
    enabled,
  };
  const host = usePluginUiHost(input);
  if (enabled) current = host;
  useEffect(() => {
    if (!enabled) return;
    phases.push(host.phase);
    void harness.event({ type: "phase", phase: host.phase, key: host.pageKey });
    if (host.phase === "running" || !host.supported) ready.resolve();
    if (host.phase === "error") ready.reject(new Error(host.error ?? "managed page failed"));
  }, [host.phase, host.pageKey, enabled]);
  return side ? (
    <PluginUiSidePaneView
      scopeRef={config.scope.scope}
      host={host}
      loadingLabel="loading"
      errorLabel="failed"
      retryLabel="retry"
    />
  ) : (
    <PluginUiCard
      {...host}
      prefersBorder={false}
      loadingLabel="loading"
      errorLabel="failed"
      retryLabel="retry"
      onRetry={host.reload}
    />
  );
}
function Fixture() {
  const [state, setState] = useState({
    inline: true,
    sidebar: false,
    sequence: undefined as number | undefined,
    remote: config.mode === "remote",
  });
  renderState = (next) => setState((previous) => ({ ...previous, ...next }));
  return (
    <ServiceProvider services={services as never}>
      <PlatformProvider platform={platform as never}>
        <div
          id="inline-scroll"
          style={{
            position: "absolute",
            left: 20,
            top: 20,
            width: config.width ?? 400,
            height: 350,
            overflow: "auto",
          }}
        >
          <div data-sandbox-page-container="true" style={{ position: "relative" }}>
            <div id="inline-anchor">
              {state.inline && (
                <Anchor
                  side={false}
                  enabled={!state.sidebar}
                  sequence={state.sequence}
                  remote={state.remote}
                />
              )}
            </div>
            <div style={{ height: 1400 }} />
          </div>
        </div>
        <div
          id="sidebar-anchor"
          style={{ position: "absolute", left: 500, top: 20, width: 450, height: 600 }}
        >
          {state.sidebar && <Anchor side enabled sequence={state.sequence} remote={state.remote} />}
        </div>
      </PlatformProvider>
    </ServiceProvider>
  );
}
const layout = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
(window as any).setAnchors = async (inline: boolean, sidebar: boolean, sequence?: number) => {
  flushSync(() => renderState({ inline, sidebar, sequence }));
  await layout();
};
(window as any).setShowcasePresentation = async (
  theme: "light" | "dark",
  locale: string,
  width: number,
) => {
  Object.assign(config, { theme, locale, width });
  // fixture 没有应用主题样式表，提供宿主 token 以验证 reader → hostContext → 页面颜色。
  for (const [token, values] of Object.entries({
    "--color-background": ["#ffffff", "#17191c"],
    "--color-panel": ["#f4f5f6", "#23272c"],
    "--color-foreground": ["#202124", "#e6edf3"],
    "--color-foreground-subtle": ["#5f6368", "#adb5bd"],
    "--color-border": ["#dadce0", "#454b52"],
  }))
    document.documentElement.style.setProperty(token, values[theme === "dark" ? 1 : 0]!);
  flushSync(() => renderState({ inline: true, sidebar: false }));
  await layout();
};
(window as any).managedState = () => ({
  actual: {
    phase: pluginUiPages.get(current.pageKey)?.snapshot().phase,
    error: pluginUiPages.get(current.pageKey)?.snapshot().error,
  },
  phase: current.phase,
  supported: current.supported,
  handle: current.handle,
  key: current.pageKey,
  visible: pluginUiPages.get(current.pageKey)?.visible,
  busy: pluginUiPages.get(current.pageKey)?.busy(),
  widget: getPluginUiWidgetState(current.pageKey),
  views: document.querySelectorAll("webview").length,
  listeners: Object.fromEntries([...channels].map(([key, listeners]) => [key, listeners.size])),
  phases,
});
(window as any).expireOffscreen = () => {
  const pending = [...deadlines];
  deadlines.clear();
  for (const run of pending) run();
};
(window as any).removeTask = () =>
  emit("task", {
    type: "workspace_task_list_changed",
    reason: "task_deleted",
    taskId: config.scope.sessionId,
  });
(window as any).runtimeUnavailable = () =>
  emit("lifecycle", {
    workspaceKey: config.scope.workspaceIdentity ?? config.scope.workspacePath,
    state: "unavailable",
  });
(window as any).retryManaged = () => current.reload();
(window as any).waitManagedPhase = (phase: string) => {
  const page = pluginUiPages.get(current.pageKey);
  if (!page || page.snapshot().phase === phase) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const off = page.subscribe(() => {
      if (page.snapshot().phase === phase) {
        off();
        resolve();
      }
    });
  });
};
(window as any).suspendManaged = () => pluginUiPages.get(current.pageKey)?.suspend();
(window as any).waitConnectionsReleased = () =>
  new Promise<void>((resolve) => {
    const check = () => {
      if ([...channels.values()].every((set) => set.size === 0)) {
        drained.delete(check);
        resolve();
      }
    };
    drained.add(check);
    check();
  });
(window as any).clearManaged = () => pluginUiPages.clear();
(window as any).setFallback = async (remote: boolean, noSandbox: boolean) => {
  const previous = platform.pluginSandbox;
  if (noSandbox) platform.pluginSandbox = undefined as never;
  flushSync(() => renderState({ inline: true, sidebar: false, remote }));
  await layout();
  platform.pluginSandbox = previous;
  return { supported: current.supported, views: document.querySelectorAll("webview").length };
};
void harness
  .config()
  .then((value: any) => {
    config = value;
    if (config.mode === "sampling") {
      let unregister: (() => void) | undefined;
      (window as any).setSamplingEnabled = (enabled: boolean) => {
        unregister?.();
        unregister = undefined;
        if (enabled)
          unregister = registerPluginUiSessionActions(config.scope, {
            sendFollowUp: async () => {
              throw new Error("Sampling must not send a conversation turn");
            },
          });
      };
      (window as any).setSamplingEnabled(true);
      const idleWaiters = new Set<() => void>();
      const settled = pluginUiPages.settled.bind(pluginUiPages);
      pluginUiPages.settled = (page) => {
        settled(page);
        for (const notify of idleWaiters) notify();
      };
      (window as any).waitSamplingIdle = () =>
        new Promise<void>((resolve) => {
          const notify = () => {
            if (!pluginUiPages.get(current.pageKey)?.busy()) {
              idleWaiters.delete(notify);
              resolve();
            }
          };
          idleWaiters.add(notify);
          notify();
        });
    }
    if (config.mode === "web") platform.pluginSandbox = undefined as never;
    createRoot(document.getElementById("root")!).render(
      config.mode === "rows" ? (
        <ServiceProvider services={services as never}>
          <PlatformProvider platform={platform as never}>
            <RowsFixture config={config} ready={ready.resolve} />
          </PlatformProvider>
        </ServiceProvider>
      ) : (
        <Fixture />
      ),
    );
  })
  .catch(ready.reject);
