import { afterEach, describe, expect, it, vi } from "vitest";
import {
  encodeWebRemoteControlRpcTransportMessage,
  type WebRemoteControlAppPayload,
  type WebRemoteControlRpcTransportPayload,
} from "@zcode/shared";

const testState = vi.hoisted(() => ({
  relayProtocolOptions: [] as Array<{
    bridgeSessionId: string;
    sendFrame(frame: WebRemoteControlRpcTransportPayload): boolean;
  }>,
  relayProtocolAdapters: [] as Array<{
    acceptPayload: ReturnType<typeof vi.fn>;
    flushPendingFrames: ReturnType<typeof vi.fn>;
    markDegraded(reasonCode?: string): void;
    replayUnacknowledged: ReturnType<typeof vi.fn>;
  }>,
  transportOptions: [] as Array<{
    onPayload(payload: WebRemoteControlAppPayload): void;
    onRawTransportPayload?(payload: unknown): boolean;
    onSendReady?(event: { kind: "same-socket" | "reconnected-socket" }): void;
    onStateChange(state: string): void;
  }>,
  recoverConnectionCalls: 0,
  desktopAppVersion: undefined as string | undefined,
  deferBootstrap: false,
  bootstrapReplies: [] as Array<() => void>,
  deferBridge: false,
  bridgeReplies: [] as Array<() => void>,
  sentPayloads: [] as WebRemoteControlAppPayload[],
}));

const renderMock = vi.fn();
const navigateMock = vi.fn();
const noticeMock = vi.fn();

vi.mock("../src/webRemoteControlVersionNotice.js", () => ({
  showWebRemoteControlVersionNotice: (...args: unknown[]) => {
    noticeMock(...args);
    return () => {};
  },
}));

vi.mock("react-dom/client", () => ({
  createRoot: () => ({ render: renderMock }),
}));

vi.mock("@zcode/ui", () => ({
  AppErrorBoundary: ({ children }: { children: unknown }) => children,
  Root: () => null,
  ZCodeIntlProvider: ({ children }: { children: unknown }) => children,
  generateMobileDeviceFingerprint: vi.fn(() => "test-mobile-fingerprint"),
  installDocumentHiddenMotionPause: vi.fn(),
  playTaskNotificationSound: vi.fn(),
  setStreamClientId: vi.fn(),
  setWebRemoteControlTerminalTransportState: vi.fn(),
}));

vi.mock("@zcode/client", () => ({
  connectViaProtocol: vi.fn(() => ({ settingService: {} })),
  connectViaWebSocket: vi.fn(),
  createAcknowledgedWebRemoteControlRelayProtocol: vi.fn((options) => {
    testState.relayProtocolOptions.push(options);
    let degraded = false;
    const degradedListeners: Array<(fault: { reasonCode: string; terminal: true }) => void> = [];
    const adapter = {
      protocol: {
        onMessage: () => ({ dispose: () => {} }),
        send: vi.fn(),
        drain: () => Promise.resolve(),
      },
      acceptPayload: vi.fn(() => true),
      flushPendingFrames: vi.fn(),
      replayUnacknowledged: vi.fn(),
      getBridgeSessionId: () => options.bridgeSessionId,
      isDegraded: () => degraded,
      onDegraded: (listener: (fault: { reasonCode: string; terminal: true }) => void) => {
        degradedListeners.push(listener);
        return { dispose: () => {} };
      },
      markDegraded: (reasonCode = "remote.rpcFrame.testFault") => {
        if (degraded) return;
        degraded = true;
        for (const listener of degradedListeners) listener({ reasonCode, terminal: true });
      },
      dispose: vi.fn(),
    };
    testState.relayProtocolAdapters.push(adapter);
    return adapter;
  }),
}));

vi.mock("../src/webRemoteControlTransport.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/webRemoteControlTransport.js")>();

  return {
    ...actual,
    WebRemoteControlTerminalTransport: class {
      constructor(
        private readonly options: {
          onPayload(payload: WebRemoteControlAppPayload): void;
          onRawTransportPayload?(payload: unknown): boolean;
          onSendReady?(event: { kind: "same-socket" | "reconnected-socket" }): void;
          onStateChange(state: string): void;
        },
      ) {
        testState.transportOptions.push(options);
      }

      start() {
        this.options.onStateChange("paired");
      }

      sendPayload(payload: WebRemoteControlAppPayload): boolean {
        testState.sentPayloads.push(payload);
        if (payload.zcode_type === "bootstrap-request") {
          const reply = () => {
            this.options.onPayload({
              zcode_type: "bootstrap-response",
              requestId: payload.requestId,
              success: true,
              result: {
                desktopAppVersion: testState.desktopAppVersion,
                windowControlSessionId: "sid-1",
                workspaces: [
                  {
                    workspacePath: "/workspace/demo",
                    label: "demo",
                    kind: "local",
                  },
                ],
                tasks: [
                  {
                    taskId: "task-1",
                    title: "Task",
                    workspacePath: "/workspace/demo",
                    workspaceLabel: "demo",
                    workspaceKind: "local",
                    createdAt: 1,
                    updatedAt: 1,
                  },
                ],
                initialViewState: {
                  activeWorkspaceKey: "/workspace/demo",
                  activeTaskId: "task-1",
                  updatedAt: 1,
                },
              },
            });
          };
          if (testState.deferBootstrap) testState.bootstrapReplies.push(reply);
          else queueMicrotask(reply);
        }
        if (payload.zcode_type === "workspace-bridge-open") {
          const reply = () => {
            this.options.onPayload({
              zcode_type: "workspace-bridge-ready",
              requestId: payload.requestId,
              bridgeSessionId: payload.bridgeSessionId,
              ...(payload.bridgeGeneration !== undefined
                ? { bridgeGeneration: payload.bridgeGeneration }
                : {}),
              ...(payload.recoveryId ? { recoveryId: payload.recoveryId } : {}),
              bridge: {
                bridgeSessionId: payload.bridgeSessionId,
                ...(payload.bridgeGeneration !== undefined
                  ? { bridgeGeneration: payload.bridgeGeneration }
                  : {}),
                ...(payload.recoveryId ? { recoveryId: payload.recoveryId } : {}),
                kind: "local",
                workspaceKey: payload.workspaceKey,
                workspacePath: "/workspace/demo",
                initialTaskId: payload.taskId,
              },
            });
          };
          if (testState.deferBridge) testState.bridgeReplies.push(reply);
          else queueMicrotask(reply);
        }
        return true;
      }

      measurePayloadBytes(): number {
        return 1;
      }

      sendPayloadResult(payload: WebRemoteControlAppPayload) {
        this.sendPayload(payload);
        return { kind: "sent" as const, bytes: 1 };
      }

      async recoverConnection(): Promise<void> {
        testState.recoverConnectionCalls += 1;
      }

      recoverInBackground() {}
      suspend() {}
      dispose() {}
    },
  };
});

function setupExternalRelayGlobals(pathname = "/remote") {
  const documentListeners = new Map<string, Array<() => void>>();
  const windowListeners = new Map<string, Array<() => void>>();
  const addListener = (
    listeners: Map<string, Array<() => void>>,
    type: string,
    listener: unknown,
  ) => {
    if (typeof listener !== "function") {
      return;
    }
    listeners.set(type, [...(listeners.get(type) ?? []), listener as () => void]);
  };
  const removeListener = (
    listeners: Map<string, Array<() => void>>,
    type: string,
    listener: unknown,
  ) => {
    listeners.set(
      type,
      (listeners.get(type) ?? []).filter((candidate) => candidate !== listener),
    );
  };
  const documentStub = {
    title: "",
    visibilityState: "visible",
    documentElement: { classList: { toggle: vi.fn() } },
    getElementById: vi.fn(() => ({ nodeType: 1 })),
    addEventListener: vi.fn((type: string, listener: unknown) =>
      addListener(documentListeners, type, listener),
    ),
    removeEventListener: vi.fn((type: string, listener: unknown) =>
      removeListener(documentListeners, type, listener),
    ),
  };
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: vi.fn(),
  });
  vi.stubGlobal("document", documentStub);
  vi.stubGlobal("window", {
    addEventListener: vi.fn((type: string, listener: unknown) =>
      addListener(windowListeners, type, listener),
    ),
    removeEventListener: vi.fn((type: string, listener: unknown) =>
      removeListener(windowListeners, type, listener),
    ),
    matchMedia: () => ({ matches: false }),
    location: {
      pathname,
      href: `https://zcode.z.ai${pathname}?sid=sid-1&hash=hash-1&t=1&mid=mid-1&app_version=1.0.0`,
      replace: navigateMock,
      search: "?sid=sid-1&hash=hash-1&t=1&mid=mid-1&app_version=1.0.0",
    },
  });
  vi.stubGlobal("navigator", {
    language: "zh-CN",
    languages: ["zh-CN"],
    onLine: true,
    userAgent: "Mobile Safari",
  });
  vi.stubGlobal("screen", {
    width: 390,
    height: 844,
    colorDepth: 24,
  });

  return {
    setVisibilityState(visibilityState: "visible" | "hidden") {
      documentStub.visibilityState = visibilityState;
    },
    dispatchDocumentEvent(type: string) {
      for (const listener of documentListeners.get(type) ?? []) {
        listener();
      }
    },
    dispatchWindowEvent(type: string) {
      for (const listener of windowListeners.get(type) ?? []) {
        listener();
      }
    },
  };
}

describe("external relay frame gap recovery", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    testState.relayProtocolOptions.length = 0;
    testState.relayProtocolAdapters.length = 0;
    testState.transportOptions.length = 0;
    testState.sentPayloads.length = 0;
    testState.recoverConnectionCalls = 0;
    testState.desktopAppVersion = undefined;
    testState.deferBootstrap = false;
    testState.bootstrapReplies.length = 0;
    testState.deferBridge = false;
    testState.bridgeReplies.length = 0;
    renderMock.mockClear();
    navigateMock.mockClear();
    noticeMock.mockClear();
  });

  it("corrects v4 before opening a business bridge", async () => {
    vi.stubEnv("BASE_URL", "/remote/v4/");
    setupExternalRelayGlobals("/remote/v4");
    testState.desktopAppVersion = "3.12.2";
    await import("../src/main.js");
    await vi.waitFor(() => expect(navigateMock).toHaveBeenCalledOnce());
    expect(new URL(navigateMock.mock.calls[0]![0]).searchParams.get("app_version")).toBe("3.12.2");
    expect(testState.relayProtocolOptions).toHaveLength(0);
    expect(noticeMock).not.toHaveBeenCalled();
  });

  it("rechecks a new pairing while the previous business bootstrap is still pending", async () => {
    vi.stubEnv("BASE_URL", "/remote/v4/");
    setupExternalRelayGlobals("/remote/v4");
    testState.desktopAppVersion = "1.0.0";
    testState.deferBridge = true;
    await import("../src/main.js");
    await vi.waitFor(() => expect(testState.bridgeReplies).toHaveLength(1));
    testState.desktopAppVersion = "3.12.2";
    testState.transportOptions[0]!.onStateChange("waiting");
    testState.transportOptions[0]!.onStateChange("paired");
    await vi.waitFor(() => expect(navigateMock).toHaveBeenCalledOnce());
    testState.bridgeReplies[0]!();
    await Promise.resolve();
    expect(noticeMock).not.toHaveBeenCalled();
  });

  it.each(["pair", "foreground"])(
    "checks v4 on %s recovery even with a healthy bridge, without unmounting the page",
    async (kind) => {
      vi.stubEnv("BASE_URL", "/remote/v4/");
      const lifecycle = setupExternalRelayGlobals("/remote/v4");
      testState.desktopAppVersion = "1.0.0";
      await import("../src/main.js");
      await vi.waitFor(() =>
        expect(
          renderMock.mock.calls.some(([element]) =>
            Boolean(element?.props?.children?.props?.children?.props?.services),
          ),
        ).toBe(true),
      );
      const renderCount = renderMock.mock.calls.length;
      testState.desktopAppVersion = "3.12.2";
      if (kind === "pair") {
        testState.transportOptions[0]!.onStateChange("waiting");
        testState.transportOptions[0]!.onStateChange("paired");
      } else {
        lifecycle.setVisibilityState("hidden");
        lifecycle.dispatchDocumentEvent("visibilitychange");
        lifecycle.setVisibilityState("visible");
        lifecycle.dispatchDocumentEvent("visibilitychange");
      }
      await vi.waitFor(() => expect(noticeMock).toHaveBeenCalledOnce());
      expect(noticeMock.mock.calls[0]![0]).toBe("3.12.2");
      expect(navigateMock).not.toHaveBeenCalled();
      expect(testState.relayProtocolOptions).toHaveLength(1);
      expect(renderMock).toHaveBeenCalledTimes(renderCount);
      const sentBeforeBlockedFrame = testState.sentPayloads.length;
      const protocol = testState.relayProtocolOptions[0]!;
      const [frame] = encodeWebRemoteControlRpcTransportMessage(new Uint8Array([1, 2, 3]), {
        bridgeSessionId: protocol.bridgeSessionId,
        firstPhysicalSeq: 1,
        messageSeq: 1,
      });
      expect(protocol.sendFrame(frame!)).toBe(false);
      expect(testState.sentPayloads).toHaveLength(sentBeforeBlockedFrame);
      noticeMock.mock.calls[0]![1]();
      expect(navigateMock).toHaveBeenCalledOnce();
    },
  );

  it("rebuilds a bridge that degrades while foreground version validation is pending", async () => {
    vi.stubEnv("BASE_URL", "/remote/v4/");
    const lifecycle = setupExternalRelayGlobals("/remote/v4");
    testState.desktopAppVersion = "1.0.0";
    await import("../src/main.js");
    await vi.waitFor(() => expect(testState.relayProtocolOptions).toHaveLength(1));

    testState.deferBootstrap = true;
    lifecycle.setVisibilityState("hidden");
    lifecycle.dispatchDocumentEvent("visibilitychange");
    lifecycle.setVisibilityState("visible");
    lifecycle.dispatchDocumentEvent("visibilitychange");
    await vi.waitFor(() => expect(testState.bootstrapReplies).toHaveLength(1));

    testState.deferBootstrap = false;
    testState.relayProtocolAdapters[0]!.markDegraded("remote.rpcFrame.missingReplay");
    testState.bootstrapReplies.shift()!();

    await vi.waitFor(() => expect(testState.relayProtocolOptions).toHaveLength(2));
    expect(
      testState.sentPayloads.filter((payload) => payload.zcode_type === "workspace-bridge-open"),
    ).toHaveLength(2);
  });

  it.each(["v4", "v3"])(
    "reports a %s bootstrap timeout after one bounded recovery retry",
    async (version) => {
      vi.useFakeTimers();
      vi.stubEnv("BASE_URL", `/remote/${version}/`);
      setupExternalRelayGlobals(`/remote/${version}`);
      testState.deferBootstrap = true;
      await import("../src/main.js");

      await vi.advanceTimersByTimeAsync(20_000);

      expect(
        renderMock.mock.calls.some(
          ([element]) => element?.props?.failure?.reason === "desktop-bootstrap-timeout",
        ),
      ).toBe(true);
      expect(
        testState.sentPayloads.filter((payload) => payload.zcode_type === "bootstrap-request"),
      ).toHaveLength(2);
    },
  );

  it("starts external relay bootstrap on the v3 remote base path", async () => {
    vi.stubEnv("BASE_URL", "/remote/v3/");
    setupExternalRelayGlobals("/remote/v3");

    await import("../src/main.js");

    await vi.waitFor(() => {
      expect(testState.relayProtocolOptions).toHaveLength(1);
    });
  });

  it("starts hard recovery when the mobile relay protocol detects an inbound rpc frame gap", async () => {
    setupExternalRelayGlobals();

    await import("../src/main.js");

    await vi.waitFor(() => {
      expect(testState.relayProtocolOptions).toHaveLength(1);
    });
    const initialBridgeOpenCount = testState.sentPayloads.filter(
      (payload) => payload.zcode_type === "workspace-bridge-open",
    ).length;
    testState.relayProtocolAdapters[0]!.markDegraded("remote.rpcFrame.physicalGap");

    await vi.waitFor(() => {
      expect(testState.recoverConnectionCalls).toBe(1);
    });
    await vi.waitFor(() => {
      expect(
        testState.sentPayloads.filter((payload) => payload.zcode_type === "workspace-bridge-open")
          .length,
      ).toBeGreaterThan(initialBridgeOpenCount);
    });
    const latestBridgeOpen = testState.sentPayloads
      .filter((payload) => payload.zcode_type === "workspace-bridge-open")
      .at(-1);
    expect(latestBridgeOpen).toMatchObject({
      zcode_type: "workspace-bridge-open",
      recoveryId: expect.stringMatching(/^recovery-/),
    });
  });

  it("routes raw ACKs before app requesters and replays whenever the same bridge is send-ready", async () => {
    setupExternalRelayGlobals();

    await import("../src/main.js");

    await vi.waitFor(() => {
      expect(testState.relayProtocolAdapters).toHaveLength(1);
      expect(testState.transportOptions).toHaveLength(1);
    });
    const adapter = testState.relayProtocolAdapters[0]!;
    const transportOptions = testState.transportOptions[0]!;
    const ack = {
      zcode_type: "rpc-frame-ack" as const,
      bridgeSessionId: testState.relayProtocolOptions[0]!.bridgeSessionId,
      ackMessageSeq: 1,
    };

    expect(transportOptions.onRawTransportPayload?.(ack)).toBe(true);
    expect(adapter.acceptPayload).toHaveBeenCalledWith(ack);

    transportOptions.onSendReady?.({ kind: "same-socket" });
    expect(adapter.replayUnacknowledged).toHaveBeenCalledOnce();
    expect(adapter.flushPendingFrames).not.toHaveBeenCalled();

    transportOptions.onSendReady?.({ kind: "reconnected-socket" });
    expect(adapter.replayUnacknowledged).toHaveBeenCalledTimes(2);
  });

  it("keeps the current bridge mounted when a short background recovery confirms pairing", async () => {
    const lifecycle = setupExternalRelayGlobals();

    await import("../src/main.js");

    await vi.waitFor(() => {
      expect(testState.relayProtocolOptions).toHaveLength(1);
    });
    const initialBridgeOpenCount = testState.sentPayloads.filter(
      (payload) => payload.zcode_type === "workspace-bridge-open",
    ).length;
    const initialBootstrapRequestCount = testState.sentPayloads.filter(
      (payload) => payload.zcode_type === "bootstrap-request",
    ).length;
    const initialRenderCount = renderMock.mock.calls.length;

    lifecycle.setVisibilityState("hidden");
    lifecycle.dispatchDocumentEvent("visibilitychange");
    lifecycle.setVisibilityState("visible");
    lifecycle.dispatchDocumentEvent("visibilitychange");

    await vi.waitFor(() => {
      expect(testState.recoverConnectionCalls).toBe(1);
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(
      testState.sentPayloads.filter((payload) => payload.zcode_type === "bootstrap-request"),
    ).toHaveLength(initialBootstrapRequestCount);
    expect(
      testState.sentPayloads.filter((payload) => payload.zcode_type === "workspace-bridge-open"),
    ).toHaveLength(initialBridgeOpenCount);
    expect(renderMock).toHaveBeenCalledTimes(initialRenderCount);
  });

  it("keeps the current bridge mounted on long lifecycle recovery until desktop reports degradation", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(0);
    const lifecycle = setupExternalRelayGlobals();

    await import("../src/main.js");

    await vi.waitFor(() => {
      expect(testState.relayProtocolOptions).toHaveLength(1);
    });
    const initialBridgeOpenCount = testState.sentPayloads.filter(
      (payload) => payload.zcode_type === "workspace-bridge-open",
    ).length;
    const initialBootstrapRequestCount = testState.sentPayloads.filter(
      (payload) => payload.zcode_type === "bootstrap-request",
    ).length;

    lifecycle.setVisibilityState("hidden");
    lifecycle.dispatchDocumentEvent("visibilitychange");
    vi.setSystemTime(6_000);
    lifecycle.setVisibilityState("visible");
    lifecycle.dispatchDocumentEvent("visibilitychange");

    await vi.waitFor(() => {
      expect(testState.recoverConnectionCalls).toBe(1);
    });
    expect(
      testState.sentPayloads.filter((payload) => payload.zcode_type === "bootstrap-request"),
    ).toHaveLength(initialBootstrapRequestCount);
    expect(
      testState.sentPayloads.filter((payload) => payload.zcode_type === "workspace-bridge-open"),
    ).toHaveLength(initialBridgeOpenCount);
  });
});
