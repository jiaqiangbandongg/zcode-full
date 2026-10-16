// 草稿态 v4 draft session 预热控制器（m5-composer-parity §5.4）生命周期测试。
// 覆盖：就绪上抛 / 未用清理 / 提升不删 / 失效不删 / 在飞 dispose 就地删 / 创建失败降级。
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandAck, SessionConfigState } from "@zcode/shared/zcode-protocol-v4";
import {
  startDraftSessionPrewarm,
  useDraftSessionPrewarm,
} from "@/v4/composer/useDraftSessionPrewarm.js";

function acceptedCreateAck(sessionId: string): CommandAck {
  return {
    commandId: "c1",
    status: "accepted",
    revisionAtDecision: 0,
    result: { type: "createSession", sessionId },
  };
}

const NOOP_ACK: CommandAck = {
  commandId: "c2",
  status: "accepted",
  revisionAtDecision: 0,
};

function createDispatchRecorder(handlers?: { onCreate?: () => Promise<CommandAck> | CommandAck }) {
  const calls: Array<{ type: string; sessionId: string | null }> = [];
  const dispatch = vi.fn(
    async (
      type: string,
      _payload: Record<string, unknown>,
      sessionId: string | null,
    ): Promise<CommandAck> => {
      calls.push({ type, sessionId });
      if (type === "createSession") {
        return handlers?.onCreate ? await handlers.onCreate() : acceptedCreateAck("draft-1");
      }
      return NOOP_ACK;
    },
  );
  return { calls, dispatch };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function flushCleanupTimers() {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await flushMicrotasks();
}

const mountedRoots: Root[] = [];

function createMinimalElement(ownerDocument: Document, tagName = "div") {
  const element = {
    addEventListener: () => {},
    appendChild: (child: { parentNode?: unknown }) => {
      child.parentNode = element;
      return child;
    },
    childNodes: [] as unknown[],
    getAttribute: () => null,
    insertBefore: (child: { parentNode?: unknown }) => {
      child.parentNode = element;
      return child;
    },
    nodeName: tagName.toUpperCase(),
    nodeType: 1,
    ownerDocument,
    parentNode: null as unknown,
    removeAttribute: () => {},
    removeChild: (child: { parentNode?: unknown }) => {
      child.parentNode = null;
      return child;
    },
    removeEventListener: () => {},
    setAttribute: () => {},
    style: {
      removeProperty: () => {},
      setProperty: () => {},
    },
    tagName: tagName.toUpperCase(),
  };
  return element as unknown as Element;
}

function installMinimalDom() {
  const documentMock = {
    addEventListener: () => {},
    createElement: (tagName: string) =>
      createMinimalElement(documentMock as unknown as Document, tagName),
    createTextNode: (nodeValue: string) => ({
      nodeType: 3,
      nodeValue,
      ownerDocument: documentMock,
      parentNode: null,
    }),
    nodeType: 9,
    removeEventListener: () => {},
  } as unknown as Document;
  const windowMock = {
    addEventListener: () => {},
    document: documentMock,
    HTMLIFrameElement: function HTMLIFrameElement() {},
    HTMLElement: function HTMLElement() {},
    Node: function Node() {},
    removeEventListener: () => {},
  };
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: documentMock,
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: windowMock,
  });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });
  return createMinimalElement(documentMock, "div");
}

function PrewarmHarness(props: {
  enabled?: boolean;
  workspaceKey: string;
  paneId?: string;
  invalidationVersion?: number;
  transportIdentity: unknown;
  dispatchCommand: ReturnType<typeof createDispatchRecorder>["dispatch"];
  resolveInitialConfig?: () => Partial<SessionConfigState>;
  resolveInitialRuntimeModel?: Parameters<typeof useDraftSessionPrewarm>[0]["resolveInitialRuntimeModel"];
  onRender: (binding: ReturnType<typeof useDraftSessionPrewarm>["binding"]) => void;
}) {
  const result = useDraftSessionPrewarm({
    enabled: props.enabled ?? true,
    workspaceKey: props.workspaceKey,
    paneId: props.paneId ?? "workspace-main",
    invalidationVersion: props.invalidationVersion,
    transportIdentity: props.transportIdentity,
    dispatchCommand: props.dispatchCommand as never,
    resolveInitialConfig: props.resolveInitialConfig,
  });
  props.onRender(result.binding);
  return null;
}

afterEach(async () => {
  for (const root of mountedRoots.splice(0)) {
    act(() => root.unmount());
  }
  await flushCleanupTimers();
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown }).IS_REACT_ACT_ENVIRONMENT;
});

describe("startDraftSessionPrewarm", () => {
  it("createSession 就绪 → onReady 上抛 sessionId", async () => {
    const { dispatch } = createDispatchRecorder();
    const onReady = vi.fn();
    startDraftSessionPrewarm({
      workspaceKey: "/w",
      dispatchCommand: dispatch as never,
      onReady,
    });
    await flushMicrotasks();
    expect(onReady).toHaveBeenCalledWith("draft-1");
  });

  it("active session 切到 draft 的首次 acquire 使用同一 commit 更新后的配置", async () => {
    const createPayloads: Record<string, unknown>[] = [];
    const dispatch = vi.fn(
      async (
        type: string,
        payload: Record<string, unknown>,
        _sessionId: string | null,
      ): Promise<CommandAck> => {
        if (type === "createSession") {
          createPayloads.push(payload);
          return acceptedCreateAck("draft-transition");
        }
        return NOOP_ACK;
      },
    );
    const transportIdentity = {};
    const root = createRoot(installMinimalDom());
    mountedRoots.push(root);

    await act(async () => {
      root.render(
        createElement(PrewarmHarness, {
          enabled: false,
          workspaceKey: "/local/transition",
          transportIdentity,
          dispatchCommand: dispatch,
          resolveInitialConfig: () => ({}),
          onRender: () => {},
        }),
      );
      await flushMicrotasks();
    });
    await act(async () => {
      root.render(
        createElement(PrewarmHarness, {
          enabled: true,
          workspaceKey: "/local/transition",
          transportIdentity,
          dispatchCommand: dispatch,
          resolveInitialConfig: () => ({
            provider: "custom-provider",
            model: "custom-model",
          }),
          onRender: () => {},
        }),
      );
      await flushMicrotasks();
    });

    expect(createPayloads).toEqual([
      {
        workspaceId: "/local/transition",
        config: { provider: "custom-provider", model: "custom-model" },
      },
    ]);
  });

  it("未提升未失效的 dispose → deleteSession 清理", async () => {
    const { calls, dispatch } = createDispatchRecorder();
    const controller = startDraftSessionPrewarm({
      workspaceKey: "/w",
      dispatchCommand: dispatch as never,
      onReady: () => {},
    });
    await flushMicrotasks();
    controller.dispose();
    await flushMicrotasks();
    expect(calls).toContainEqual({ type: "deleteSession", sessionId: "draft-1" });
  });

  it("已提升（首发成功）的 dispose → 不删除", async () => {
    const { calls, dispatch } = createDispatchRecorder();
    const controller = startDraftSessionPrewarm({
      workspaceKey: "/w",
      dispatchCommand: dispatch as never,
      onReady: () => {},
    });
    await flushMicrotasks();
    controller.markPromoted();
    controller.dispose();
    await flushMicrotasks();
    expect(calls.some((call) => call.type === "deleteSession")).toBe(false);
  });

  it("首发 admission ACK 在途时 dispose → 不删除可能已运行的会话", async () => {
    const { calls, dispatch } = createDispatchRecorder();
    const controller = startDraftSessionPrewarm({
      workspaceKey: "/w",
      dispatchCommand: dispatch as never,
      onReady: () => {},
    });
    await flushMicrotasks();
    controller.markPromotionPending();
    controller.dispose();
    controller.markPromoted();
    await flushMicrotasks();
    expect(calls.some((call) => call.type === "deleteSession")).toBe(false);
  });

  it("已失效（订阅错误/首发被拒）的 dispose → 不发 deleteSession", async () => {
    const { calls, dispatch } = createDispatchRecorder();
    const controller = startDraftSessionPrewarm({
      workspaceKey: "/w",
      dispatchCommand: dispatch as never,
      onReady: () => {},
    });
    await flushMicrotasks();
    controller.markDiscarded();
    controller.dispose();
    await flushMicrotasks();
    expect(calls.some((call) => call.type === "deleteSession")).toBe(false);
  });

  it("创建在飞时 dispose（StrictMode 双挂载）→ ack 到达后就地删除，不上抛 onReady", async () => {
    let resolveCreate!: (ack: CommandAck) => void;
    const { calls, dispatch } = createDispatchRecorder({
      onCreate: () =>
        new Promise<CommandAck>((resolve) => {
          resolveCreate = resolve;
        }),
    });
    const onReady = vi.fn();
    const controller = startDraftSessionPrewarm({
      workspaceKey: "/w",
      dispatchCommand: dispatch as never,
      onReady,
    });
    controller.dispose();
    resolveCreate(acceptedCreateAck("draft-late"));
    await flushMicrotasks();
    expect(onReady).not.toHaveBeenCalled();
    expect(calls).toContainEqual({ type: "deleteSession", sessionId: "draft-late" });
  });

  it("resolveInitialConfig 返回全局偏好 → createSession 携带 config（不闪）", async () => {
    const payloads: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const dispatch = vi.fn(
      async (type: string, payload: Record<string, unknown>): Promise<CommandAck> => {
        payloads.push({ type, payload });
        return type === "createSession" ? acceptedCreateAck("draft-1") : NOOP_ACK;
      },
    );
    startDraftSessionPrewarm({
      workspaceKey: "/w",
      dispatchCommand: dispatch as never,
      onReady: () => {},
      resolveInitialConfig: () => ({ provider: "glm", model: "glm-4.6" }),
    });
    await flushMicrotasks();
    const create = payloads.find((p) => p.type === "createSession");
    expect(create?.payload).toEqual({
      workspaceId: "/w",
      config: { provider: "glm", model: "glm-4.6" },
    });
  });

  it("resolveInitialConfig 返回 undefined → createSession 不带 config（无全局偏好回落缺省）", async () => {
    const payloads: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const dispatch = vi.fn(
      async (type: string, payload: Record<string, unknown>): Promise<CommandAck> => {
        payloads.push({ type, payload });
        return type === "createSession" ? acceptedCreateAck("draft-1") : NOOP_ACK;
      },
    );
    startDraftSessionPrewarm({
      workspaceKey: "/w",
      dispatchCommand: dispatch as never,
      onReady: () => {},
      resolveInitialConfig: () => undefined,
    });
    await flushMicrotasks();
    const create = payloads.find((p) => p.type === "createSession");
    expect(create?.payload).toEqual({ workspaceId: "/w" });
  });

  it("createSession 被拒/异常 → 降级无预热，不上抛不清理", async () => {
    const rejected: CommandAck = {
      commandId: "c3",
      status: "rejected",
      reasonCode: "proto.sessionNotFound",
      revisionAtDecision: 0,
    };
    const { calls, dispatch } = createDispatchRecorder({ onCreate: () => rejected });
    const onReady = vi.fn();
    const controller = startDraftSessionPrewarm({
      workspaceKey: "/w",
      dispatchCommand: dispatch as never,
      onReady,
    });
    await flushMicrotasks();
    controller.dispose();
    await flushMicrotasks();
    expect(onReady).not.toHaveBeenCalled();
    expect(calls.some((call) => call.type === "deleteSession")).toBe(false);
  });
});

describe("useDraftSessionPrewarm workspace owner", () => {
  it("切换 workspace 时旧 binding 立即失效，并通过原 workspace dispatcher 清理", async () => {
    const observations: Array<{ workspaceKey: string; sessionId: string | null }> = [];
    const dispatchA = createDispatchRecorder({
      onCreate: () => acceptedCreateAck("draft-a"),
    });
    const dispatchB = createDispatchRecorder({
      onCreate: () => acceptedCreateAck("draft-b"),
    });

    const root = createRoot(installMinimalDom());
    mountedRoots.push(root);
    await act(async () => {
      root.render(
        createElement(PrewarmHarness, {
          workspaceKey: "remote:ssh:a:/workspace",
          transportIdentity: dispatchA.dispatch,
          dispatchCommand: dispatchA.dispatch,
          onRender: (binding) => {
            observations.push({
              workspaceKey: "remote:ssh:a:/workspace",
              sessionId: binding?.sessionId ?? null,
            });
          },
        }),
      );
      await flushMicrotasks();
    });
    expect(observations.at(-1)).toEqual({
      workspaceKey: "remote:ssh:a:/workspace",
      sessionId: "draft-a",
    });

    const switchObservationStart = observations.length;
    await act(async () => {
      root.render(
        createElement(PrewarmHarness, {
          workspaceKey: "remote:ssh:b:/workspace",
          transportIdentity: dispatchB.dispatch,
          dispatchCommand: dispatchB.dispatch,
          onRender: (binding) => {
            observations.push({
              workspaceKey: "remote:ssh:b:/workspace",
              sessionId: binding?.sessionId ?? null,
            });
          },
        }),
      );
      await flushMicrotasks();
    });
    await flushCleanupTimers();

    expect(observations.slice(switchObservationStart)).not.toContainEqual({
      workspaceKey: "remote:ssh:b:/workspace",
      sessionId: "draft-a",
    });
    expect(observations.at(-1)).toEqual({
      workspaceKey: "remote:ssh:b:/workspace",
      sessionId: "draft-b",
    });
    expect(dispatchA.calls).toContainEqual({ type: "deleteSession", sessionId: "draft-a" });
    expect(dispatchB.calls).not.toContainEqual({ type: "deleteSession", sessionId: "draft-a" });
  });

  it("本地同 workspace 仅 lease dispatcher 更新时不重建预热，清理使用该 owner 最新入口", async () => {
    const initial = createDispatchRecorder({
      onCreate: () => acceptedCreateAck("draft-local"),
    });
    const latest = createDispatchRecorder({
      onCreate: () => acceptedCreateAck("should-not-create"),
    });
    const transportIdentity = {};
    const observedSessionIds: Array<string | null> = [];
    const root = createRoot(installMinimalDom());
    mountedRoots.push(root);

    await act(async () => {
      root.render(
        createElement(PrewarmHarness, {
          workspaceKey: "/local/workspace",
          transportIdentity,
          dispatchCommand: initial.dispatch,
          onRender: (binding) => observedSessionIds.push(binding?.sessionId ?? null),
        }),
      );
      await flushMicrotasks();
    });
    await act(async () => {
      root.render(
        createElement(PrewarmHarness, {
          workspaceKey: "/local/workspace",
          transportIdentity,
          dispatchCommand: latest.dispatch,
          onRender: (binding) => observedSessionIds.push(binding?.sessionId ?? null),
        }),
      );
      await flushMicrotasks();
    });

    expect(observedSessionIds.at(-1)).toBe("draft-local");
    expect(initial.calls.filter((call) => call.type === "createSession")).toHaveLength(1);
    expect(latest.calls.some((call) => call.type === "createSession")).toBe(false);

    await act(async () => root.unmount());
    mountedRoots.pop();
    await flushCleanupTimers();
    expect(initial.calls.some((call) => call.type === "deleteSession")).toBe(false);
    expect(latest.calls).toContainEqual({ type: "deleteSession", sessionId: "draft-local" });
  });

  it("同 workspace 的初始配置 resolver 换 identity 时不重建已有预热", async () => {
    const recorder = createDispatchRecorder({
      onCreate: () => acceptedCreateAck("draft-local"),
    });
    const transportIdentity = {};
    const root = createRoot(installMinimalDom());
    mountedRoots.push(root);

    await act(async () => {
      root.render(
        createElement(PrewarmHarness, {
          workspaceKey: "/local/workspace",
          transportIdentity,
          dispatchCommand: recorder.dispatch,
          resolveInitialConfig: () => ({ followupMode: "queue" }),
          onRender: () => {},
        }),
      );
      await flushMicrotasks();
    });
    await act(async () => {
      root.render(
        createElement(PrewarmHarness, {
          workspaceKey: "/local/workspace",
          transportIdentity,
          dispatchCommand: recorder.dispatch,
          resolveInitialConfig: () => ({ followupMode: "steer" }),
          onRender: () => {},
        }),
      );
      await flushMicrotasks();
    });

    expect(recorder.calls.filter((call) => call.type === "createSession")).toHaveLength(1);
    expect(recorder.calls.some((call) => call.type === "deleteSession")).toBe(false);
  });

  it("旧 workspace 的延迟 create ACK 只回原 dispatcher 清理，不成为新 workspace binding", async () => {
    let resolveCreateA!: (ack: CommandAck) => void;
    const dispatchA = createDispatchRecorder({
      onCreate: () =>
        new Promise<CommandAck>((resolve) => {
          resolveCreateA = resolve;
        }),
    });
    const dispatchB = createDispatchRecorder({
      onCreate: () => acceptedCreateAck("draft-b"),
    });
    const observedB: Array<string | null> = [];
    const root = createRoot(installMinimalDom());
    mountedRoots.push(root);

    await act(async () => {
      root.render(
        createElement(PrewarmHarness, {
          workspaceKey: "/local/a",
          transportIdentity: dispatchA.dispatch,
          dispatchCommand: dispatchA.dispatch,
          onRender: () => {},
        }),
      );
      await flushMicrotasks();
    });
    await act(async () => {
      root.render(
        createElement(PrewarmHarness, {
          workspaceKey: "/local/b",
          transportIdentity: dispatchB.dispatch,
          dispatchCommand: dispatchB.dispatch,
          onRender: (binding) => observedB.push(binding?.sessionId ?? null),
        }),
      );
      await flushMicrotasks();
    });
    await flushCleanupTimers();
    await act(async () => {
      resolveCreateA(acceptedCreateAck("draft-late-a"));
      await flushMicrotasks();
    });

    expect(observedB).not.toContain("draft-late-a");
    expect(observedB.at(-1)).toBe("draft-b");
    expect(dispatchA.calls).toContainEqual({
      type: "deleteSession",
      sessionId: "draft-late-a",
    });
    expect(dispatchB.calls).not.toContainEqual({
      type: "deleteSession",
      sessionId: "draft-late-a",
    });
  });

  it("旧 binding 的延迟 promote/discard 不会修改新 workspace controller", async () => {
    const dispatchA = createDispatchRecorder({
      onCreate: () => acceptedCreateAck("draft-a"),
    });
    const dispatchB = createDispatchRecorder({
      onCreate: () => acceptedCreateAck("draft-b"),
    });
    let bindingA: ReturnType<typeof useDraftSessionPrewarm>["binding"] = null;
    let bindingB: ReturnType<typeof useDraftSessionPrewarm>["binding"] = null;
    const root = createRoot(installMinimalDom());
    mountedRoots.push(root);

    await act(async () => {
      root.render(
        createElement(PrewarmHarness, {
          workspaceKey: "/local/a",
          transportIdentity: dispatchA.dispatch,
          dispatchCommand: dispatchA.dispatch,
          onRender: (binding) => {
            bindingA = binding;
          },
        }),
      );
      await flushMicrotasks();
    });
    await act(async () => {
      root.render(
        createElement(PrewarmHarness, {
          workspaceKey: "/local/b",
          transportIdentity: dispatchB.dispatch,
          dispatchCommand: dispatchB.dispatch,
          onRender: (binding) => {
            bindingB = binding;
          },
        }),
      );
      await flushMicrotasks();
    });

    expect(bindingA?.sessionId).toBe("draft-a");
    expect(bindingB?.sessionId).toBe("draft-b");
    bindingA?.promote();
    bindingA?.discard();

    await act(async () => root.unmount());
    mountedRoots.pop();
    await flushCleanupTimers();
    expect(dispatchB.calls).toContainEqual({ type: "deleteSession", sessionId: "draft-b" });
  });

  it("同 owner 同步重挂复用在途 createSession，不产生 create/delete churn", async () => {
    let resolveCreate!: (ack: CommandAck) => void;
    const recorder = createDispatchRecorder({
      onCreate: () =>
        new Promise<CommandAck>((resolve) => {
          resolveCreate = resolve;
        }),
    });
    const transportIdentity = {};
    const observedSessionIds: Array<string | null> = [];
    const root = createRoot(installMinimalDom());
    mountedRoots.push(root);
    const renderHarness = () =>
      createElement(PrewarmHarness, {
        workspaceKey: "/local/workspace",
        paneId: "workspace-main",
        transportIdentity,
        dispatchCommand: recorder.dispatch,
        onRender: (binding) => observedSessionIds.push(binding?.sessionId ?? null),
      });

    await act(async () => {
      root.render(renderHarness());
      await flushMicrotasks();
    });
    act(() => root.render(null));
    await act(async () => {
      root.render(renderHarness());
      await flushMicrotasks();
    });

    expect(recorder.calls.filter((call) => call.type === "createSession")).toHaveLength(1);
    expect(recorder.calls.some((call) => call.type === "deleteSession")).toBe(false);

    await act(async () => {
      resolveCreate(acceptedCreateAck("draft-shared"));
      await flushMicrotasks();
    });
    expect(observedSessionIds.at(-1)).toBe("draft-shared");
  });

  it("真实卸载后同 owner 重挂会等待旧 create 收口，不并发创建", async () => {
    let resolveFirstCreate!: (ack: CommandAck) => void;
    let createCount = 0;
    const recorder = createDispatchRecorder({
      onCreate: () => {
        createCount += 1;
        if (createCount === 1) {
          return new Promise<CommandAck>((resolve) => {
            resolveFirstCreate = resolve;
          });
        }
        return acceptedCreateAck("draft-reacquired");
      },
    });
    const transportIdentity = {};
    const root = createRoot(installMinimalDom());
    mountedRoots.push(root);
    const renderHarness = () =>
      createElement(PrewarmHarness, {
        workspaceKey: "/local/workspace",
        paneId: "workspace-main",
        transportIdentity,
        dispatchCommand: recorder.dispatch,
        onRender: () => {},
      });

    await act(async () => {
      root.render(renderHarness());
      await flushMicrotasks();
    });
    act(() => root.render(null));
    await flushCleanupTimers();
    await act(async () => {
      root.render(renderHarness());
      await flushMicrotasks();
    });

    expect(recorder.calls.filter((call) => call.type === "createSession")).toHaveLength(1);

    await act(async () => {
      resolveFirstCreate(acceptedCreateAck("draft-retired"));
      await flushMicrotasks();
    });
    expect(recorder.calls.slice(0, 3)).toEqual([
      { type: "createSession", sessionId: null },
      { type: "deleteSession", sessionId: "draft-retired" },
      { type: "createSession", sessionId: null },
    ]);
  });

  it("同 workspace 的显式 split draft 按 paneId 保持独立预热", async () => {
    const recorder = createDispatchRecorder();
    const transportIdentity = {};
    const firstRoot = createRoot(installMinimalDom());
    const secondRoot = createRoot(createMinimalElement(document, "div"));
    mountedRoots.push(firstRoot, secondRoot);

    await act(async () => {
      firstRoot.render(
        createElement(PrewarmHarness, {
          workspaceKey: "/local/workspace",
          paneId: "pane-a",
          transportIdentity,
          dispatchCommand: recorder.dispatch,
          onRender: () => {},
        }),
      );
      secondRoot.render(
        createElement(PrewarmHarness, {
          workspaceKey: "/local/workspace",
          paneId: "pane-b",
          transportIdentity,
          dispatchCommand: recorder.dispatch,
          onRender: () => {},
        }),
      );
      await flushMicrotasks();
    });

    expect(recorder.calls.filter((call) => call.type === "createSession")).toHaveLength(2);
  });

  it("旧 createSession 在飞时连续失效只保留最新代，并按 create→delete→create 排序", async () => {
    let resolveFirstCreate!: (ack: CommandAck) => void;
    let createCount = 0;
    const calls: Array<{ type: string; sessionId: string | null }> = [];
    const dispatch = vi.fn(
      async (
        type: string,
        _payload: Record<string, unknown>,
        sessionId: string | null,
      ): Promise<CommandAck> => {
        calls.push({ type, sessionId });
        if (type !== "createSession") {
          return NOOP_ACK;
        }
        createCount += 1;
        if (createCount === 1) {
          return await new Promise<CommandAck>((resolve) => {
            resolveFirstCreate = resolve;
          });
        }
        return acceptedCreateAck(`draft-${createCount}`);
      },
    );
    const transportIdentity = {};
    const observedSessionIds: Array<string | null> = [];
    const root = createRoot(installMinimalDom());
    mountedRoots.push(root);
    const renderVersion = (invalidationVersion: number) =>
      createElement(PrewarmHarness, {
        workspaceKey: "/local/workspace",
        paneId: "workspace-main",
        invalidationVersion,
        transportIdentity,
        dispatchCommand: dispatch,
        onRender: (binding) => observedSessionIds.push(binding?.sessionId ?? null),
      });

    await act(async () => {
      root.render(renderVersion(0));
      await flushMicrotasks();
    });
    await act(async () => {
      root.render(renderVersion(1));
      await flushMicrotasks();
      root.render(renderVersion(2));
      await flushMicrotasks();
    });

    expect(calls.filter((call) => call.type === "createSession")).toHaveLength(1);

    await act(async () => {
      resolveFirstCreate(acceptedCreateAck("draft-old"));
      await flushMicrotasks();
    });

    expect(calls.slice(0, 3)).toEqual([
      { type: "createSession", sessionId: null },
      { type: "deleteSession", sessionId: "draft-old" },
      { type: "createSession", sessionId: null },
    ]);
    expect(calls.filter((call) => call.type === "createSession")).toHaveLength(2);
    expect(observedSessionIds.at(-1)).toBe("draft-2");
  });

  it("discard 后递增 invalidationVersion → 解除 blocked 并重建预热会话", async () => {
    const calls: Array<{ type: string; sessionId: string | null }> = [];
    let createCount = 0;
    const dispatch = vi.fn(
      async (
        type: string,
        _payload: Record<string, unknown>,
        sessionId: string | null,
      ): Promise<CommandAck> => {
        calls.push({ type, sessionId });
        if (type === "createSession") {
          createCount += 1;
          return acceptedCreateAck(`draft-${createCount}`);
        }
        return NOOP_ACK;
      },
    );
    const transportIdentity = {};
    const observed: Array<ReturnType<typeof useDraftSessionPrewarm>["binding"]> = [];
    const root = createRoot(installMinimalDom());
    mountedRoots.push(root);
    const renderVersion = (invalidationVersion: number) =>
      createElement(PrewarmHarness, {
        workspaceKey: "/local/workspace",
        paneId: "workspace-main",
        invalidationVersion,
        transportIdentity,
        dispatchCommand: dispatch,
        onRender: (binding) => observed.push(binding),
      });

    await act(async () => {
      root.render(renderVersion(0));
      await flushMicrotasks();
    });
    expect(observed.at(-1)?.sessionId).toBe("draft-1");

    // 订阅失败路径：SessionPane 会调 discard()，它把当前版本标记为 blocked。
    await act(async () => {
      observed.at(-1)?.discard();
      await flushMicrotasks();
    });
    expect(observed.at(-1)).toBeNull();

    // 同版本不重建（blocked 生效）。
    await act(async () => {
      root.render(renderVersion(0));
      await flushMicrotasks();
    });
    expect(calls.filter((call) => call.type === "createSession")).toHaveLength(1);

    // 递增版本 → 解除 blocked → 重建。
    await act(async () => {
      root.render(renderVersion(1));
      await flushMicrotasks();
    });
    expect(calls.filter((call) => call.type === "createSession")).toHaveLength(2);
    expect(observed.at(-1)?.sessionId).toBe("draft-2");
  });

  it("createSession 失败 → 有界退避自动重试，重试成功后上抛 binding", async () => {
    vi.useFakeTimers();
    const calls: Array<{ type: string; sessionId: string | null }> = [];
    let createCount = 0;
    const dispatch = vi.fn(
      async (
        type: string,
        _payload: Record<string, unknown>,
        sessionId: string | null,
      ): Promise<CommandAck> => {
        calls.push({ type, sessionId });
        if (type === "createSession") {
          createCount += 1;
          // 首次撞上 Helper ready 触发的回收（client disposed），重试时回收已结束。
          if (createCount === 1) throw new Error("ZCode Protocol client disposed");
          return acceptedCreateAck(`draft-${createCount}`);
        }
        return NOOP_ACK;
      },
    );
    const observed: Array<ReturnType<typeof useDraftSessionPrewarm>["binding"]> = [];
    const root = createRoot(installMinimalDom());
    mountedRoots.push(root);

    await act(async () => {
      root.render(
        createElement(PrewarmHarness, {
          workspaceKey: "/local/workspace",
          transportIdentity: {},
          dispatchCommand: dispatch,
          onRender: (binding) => observed.push(binding),
        }),
      );
      await flushMicrotasks();
    });
    expect(calls.filter((call) => call.type === "createSession")).toHaveLength(1);
    expect(observed.at(-1)).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
      await flushMicrotasks();
    });

    expect(calls.filter((call) => call.type === "createSession")).toHaveLength(2);
    expect(observed.at(-1)?.sessionId).toBe("draft-2");
    vi.useRealTimers();
  });

  it("createSession 持续失败 → 退避用尽后停止重试，不无限风暴", async () => {
    vi.useFakeTimers();
    const calls: Array<{ type: string; sessionId: string | null }> = [];
    const dispatch = vi.fn(
      async (
        type: string,
        _payload: Record<string, unknown>,
        sessionId: string | null,
      ): Promise<CommandAck> => {
        calls.push({ type, sessionId });
        if (type === "createSession") throw new Error("ZCode Protocol client disposed");
        return NOOP_ACK;
      },
    );
    const root = createRoot(installMinimalDom());
    mountedRoots.push(root);

    await act(async () => {
      root.render(
        createElement(PrewarmHarness, {
          workspaceKey: "/local/workspace",
          transportIdentity: {},
          dispatchCommand: dispatch,
          onRender: () => {},
        }),
      );
      await flushMicrotasks();
    });

    for (const delay of [500, 1000, 2000, 4000]) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(delay);
        await flushMicrotasks();
      });
    }

    // 首发 + 3 次退避重试 = 4 次，之后不再尝试。
    expect(calls.filter((call) => call.type === "createSession")).toHaveLength(4);
    vi.useRealTimers();
  });
});
