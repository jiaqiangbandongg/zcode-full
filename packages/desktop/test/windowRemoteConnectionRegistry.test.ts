import { afterEach, describe, expect, it, vi } from "vitest";
import type { RemoteTarget } from "@zcode/shared";
import {
  WindowRemoteConnectionUnavailableError,
  createWindowRemoteConnectionRegistry,
  type WindowRemoteConnectionHandle,
} from "../src/host/windowRemoteConnectionRegistry.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function createHandle<TCapabilities = never>(services: string, capabilities?: TCapabilities) {
  const closeListeners = new Set<
    (event: { exitCode: number | null; signal: string | null }) => void
  >();
  const dispose = vi.fn(async () => undefined);
  const handle: WindowRemoteConnectionHandle<string, TCapabilities> = {
    services,
    ...(capabilities === undefined ? {} : { capabilities }),
    dispose,
    onDidClose(listener) {
      closeListeners.add(listener);
      return { dispose: () => closeListeners.delete(listener) };
    },
  };
  return {
    handle,
    dispose,
    close(event = { exitCode: 255, signal: null }) {
      for (const listener of closeListeners) {
        listener(event);
      }
    },
  };
}

const sshTarget: RemoteTarget = {
  kind: "ssh",
  host: "dev.internal",
  username: "developer",
};

describe("WindowRemoteConnectionRegistry", () => {
  afterEach(() => vi.useRealTimers());
  it("同窗口相同 SSH target 复用连接，但分配独立 logical session", async () => {
    const connection = createHandle("ssh-services");
    const connect = vi.fn(async () => connection.handle);
    let id = 0;
    const registry = createWindowRemoteConnectionRegistry({
      connect,
      createId: () => `remote-session-${++id}`,
    });

    const [first, second] = await Promise.all([
      registry.connect({ requestId: "request-1", target: sshTarget, remoteAssets: {} }),
      registry.connect({ requestId: "request-2", target: sshTarget, remoteAssets: {} }),
    ]);

    expect(connect).toHaveBeenCalledTimes(1);
    expect(first.remoteSessionId).not.toBe(second.remoteSessionId);
    expect(registry.getStats()).toEqual({ connectionCount: 1, logicalSessionCount: 2 });
    registry.bindWorkspaceContext({
      remoteSessionId: first.remoteSessionId,
      workspacePath: "/work/a",
      workspaceIdentity: "remote:ssh:a",
    });
    registry.bindWorkspaceContext({
      remoteSessionId: second.remoteSessionId,
      workspacePath: "/work/b",
      workspaceIdentity: "remote:ssh:b",
    });
    expect(
      registry.resolveScopedServices({
        kind: "remote",
        remoteSessionId: first.remoteSessionId,
        workspacePath: "/work/a",
        workspaceIdentity: "remote:ssh:a",
      }),
    ).toBe("ssh-services");

    await registry.disposeSession(first.remoteSessionId);
    expect(connection.dispose).not.toHaveBeenCalled();
    await registry.disposeSession(second.remoteSessionId);
    // ready SSH connection 保持既有 window cache，直到窗口 Host 退出。
    expect(connection.dispose).not.toHaveBeenCalled();
    expect(registry.getStats()).toEqual({ connectionCount: 1, logicalSessionCount: 0 });
    await registry.dispose();
    expect(connection.dispose).toHaveBeenCalledTimes(1);
    expect(registry.getStats()).toEqual({ connectionCount: 0, logicalSessionCount: 0 });
  });

  it("通过完整远程 scope 解析各 logical session 所属连接的能力", async () => {
    const dockerCapability = { recordingUploader: "docker-uploader" };
    const otherDockerCapability = { recordingUploader: "other-docker-uploader" };
    const dockerConnection = createHandle("docker-services", dockerCapability);
    const otherDockerConnection = createHandle("other-docker-services", otherDockerCapability);
    const connect = vi
      .fn()
      .mockResolvedValueOnce(dockerConnection.handle)
      .mockResolvedValueOnce(otherDockerConnection.handle);
    let id = 0;
    const registry = createWindowRemoteConnectionRegistry({
      connect,
      createId: () => `remote-session-${++id}`,
    });

    const dockerSession = await registry.connect({
      requestId: "docker-request",
      target: { kind: "docker", container: "demo" },
      remoteAssets: {},
      workspacePath: "/work/docker",
      workspaceIdentity: "remote:docker:demo:/work/docker",
    });
    const otherDockerSession = await registry.connect({
      requestId: "other-docker-request",
      target: { kind: "docker", container: "other-demo" },
      remoteAssets: {},
      workspacePath: "/work/other-docker",
      workspaceIdentity: "remote:docker:other-demo:/work/other-docker",
    });

    expect(
      registry.resolveScopedCapabilities({
        kind: "remote",
        remoteSessionId: dockerSession.remoteSessionId,
        workspacePath: "/work/docker",
        workspaceIdentity: "remote:docker:demo:/work/docker",
      }),
    ).toBe(dockerCapability);
    expect(
      registry.resolveScopedCapabilities({
        kind: "remote",
        remoteSessionId: otherDockerSession.remoteSessionId,
        workspacePath: "/work/other-docker",
        workspaceIdentity: "remote:docker:other-demo:/work/other-docker",
      }),
    ).toBe(otherDockerCapability);

    await registry.dispose();
  });

  it("Docker 和 Server 为每个 logical session 建立 dedicated connection", async () => {
    let connectionId = 0;
    const connect = vi.fn(async () => createHandle(`services-${++connectionId}`).handle);
    let sessionId = 0;
    const registry = createWindowRemoteConnectionRegistry({
      connect,
      createId: () => `remote-session-${++sessionId}`,
    });

    await registry.connect({
      requestId: "docker-1",
      target: { kind: "docker", container: "demo" },
      remoteAssets: {},
    });
    await registry.connect({
      requestId: "docker-2",
      target: { kind: "docker", container: "demo" },
      remoteAssets: {},
    });
    await registry.connect({
      requestId: "server-1",
      target: { kind: "server", url: "https://server.example.com" },
      remoteAssets: {},
    });
    await registry.connect({
      requestId: "server-2",
      target: { kind: "server", url: "https://server.example.com/ws" },
      remoteAssets: {},
    });

    expect(connect).toHaveBeenCalledTimes(4);
  });

  // docs/dynamic-workflow/launch.md「The user's choice」：用户选择变化后要推给本窗口每个在线的远程 Host，
  // 按连接粒度去重（同一 SSH 连接上的多个 logical session 只推一次），未就绪与已释放的连接不在列。
  it("listReadyConnections 按连接去重列出已就绪连接及其 target", async () => {
    const ssh = createHandle("ssh-services");
    const pendingDocker = deferred<WindowRemoteConnectionHandle<string>>();
    const connect = vi.fn(async (request: { target: RemoteTarget }) =>
      request.target.kind === "docker" ? pendingDocker.promise : ssh.handle,
    );
    let sessionId = 0;
    const registry = createWindowRemoteConnectionRegistry({
      connect,
      createId: () => `remote-session-${++sessionId}`,
    });

    await registry.connect({ requestId: "ssh-1", target: sshTarget, remoteAssets: {} });
    await registry.connect({ requestId: "ssh-2", target: sshTarget, remoteAssets: {} });
    const dockerConnect = registry.connect({
      requestId: "docker-1",
      target: { kind: "docker", container: "demo" },
      remoteAssets: {},
    });

    expect(registry.listReadyConnections()).toEqual([
      { target: sshTarget, services: "ssh-services" },
    ]);

    pendingDocker.resolve(createHandle("docker-services").handle);
    await dockerConnect;
    expect(registry.listReadyConnections().map((entry) => entry.services).sort()).toEqual([
      "docker-services",
      "ssh-services",
    ]);

    await registry.dispose();
    expect(registry.listReadyConnections()).toEqual([]);
  });

  it("取消 pending connect 后忽略 late completion，并在无 owner 时释放连接", async () => {
    const pending = deferred<WindowRemoteConnectionHandle<string>>();
    const connection = createHandle("late-services");
    const registry = createWindowRemoteConnectionRegistry({
      connect: () => pending.promise,
      createId: () => "remote-session-late",
    });

    const result = registry.connect({
      requestId: "request-late",
      target: sshTarget,
      remoteAssets: {},
    });
    registry.cancelConnect("request-late");

    await expect(result).rejects.toThrow("远程连接已取消");
    pending.resolve(connection.handle);
    await Promise.resolve();
    await Promise.resolve();

    expect(connection.dispose).toHaveBeenCalledTimes(1);
    expect(registry.getSession("remote-session-late")).toBeNull();
  });

  it("最后一个 pending connect 取消后，同 key 重连使用本次凭据创建新连接", async () => {
    const firstPending = deferred<WindowRemoteConnectionHandle<string>>();
    const secondPending = deferred<WindowRemoteConnectionHandle<string>>();
    const firstConnection = createHandle("first-services");
    const secondConnection = createHandle("second-services");
    const observedRequests: Array<{ password?: string; signal: AbortSignal }> = [];
    let connectionId = 0;
    let sessionId = 0;
    const registry = createWindowRemoteConnectionRegistry({
      connect: (request) => {
        observedRequests.push({
          password:
            request.target.kind === "ssh" ? request.target.password : undefined,
          signal: request.signal,
        });
        connectionId += 1;
        return connectionId === 1 ? firstPending.promise : secondPending.promise;
      },
      createId: () => `remote-session-${++sessionId}`,
    });

    const first = registry.connect({
      requestId: "request-first",
      target: { ...sshTarget, password: "old-password" },
      remoteAssets: {},
    });
    registry.cancelConnect("request-first");
    await expect(first).rejects.toThrow("远程连接已取消");

    const second = registry.connect({
      requestId: "request-second",
      target: { ...sshTarget, password: "new-password" },
      remoteAssets: {},
    });

    expect(observedRequests).toHaveLength(2);
    expect(observedRequests[0]).toMatchObject({
      password: "old-password",
      signal: expect.objectContaining({ aborted: true }),
    });
    expect(observedRequests[1]).toMatchObject({
      password: "new-password",
      signal: expect.objectContaining({ aborted: false }),
    });

    firstPending.resolve(firstConnection.handle);
    secondPending.resolve(secondConnection.handle);
    await expect(second).resolves.toMatchObject({
      remoteSessionId: "remote-session-2",
    });
    await Promise.resolve();

    expect(firstConnection.dispose).toHaveBeenCalledTimes(1);
    expect(secondConnection.dispose).not.toHaveBeenCalled();
    await registry.dispose();
  });

  it("共享 connecting entry 仍有 waiter 时，取消其中一个不会中断连接", async () => {
    const pending = deferred<WindowRemoteConnectionHandle<string>>();
    const connection = createHandle("shared-services");
    const observedSignals: AbortSignal[] = [];
    let sessionId = 0;
    const registry = createWindowRemoteConnectionRegistry({
      connect: (request) => {
        observedSignals.push(request.signal);
        return pending.promise;
      },
      createId: () => `remote-session-${++sessionId}`,
    });

    const first = registry.connect({
      requestId: "request-first",
      target: sshTarget,
      remoteAssets: {},
    });
    const second = registry.connect({
      requestId: "request-second",
      target: sshTarget,
      remoteAssets: {},
    });

    registry.cancelConnect("request-first");
    await expect(first).rejects.toThrow("远程连接已取消");
    expect(observedSignals).toHaveLength(1);
    expect(observedSignals[0]?.aborted).toBe(false);

    pending.resolve(connection.handle);
    await expect(second).resolves.toMatchObject({
      remoteSessionId: "remote-session-2",
    });
    await registry.dispose();
  });

  it("WSL pending connect 取消只结束 logical waiter，不中断或换代 transport", async () => {
    const pending = deferred<WindowRemoteConnectionHandle<string>>();
    const connection = createHandle("wsl-services");
    const observedSignals: AbortSignal[] = [];
    let sessionId = 0;
    const connect = vi.fn((request: { signal: AbortSignal }) => {
      observedSignals.push(request.signal);
      return pending.promise;
    });
    const registry = createWindowRemoteConnectionRegistry({
      connect,
      createId: () => `remote-session-${++sessionId}`,
    });
    const target: RemoteTarget = { kind: "wsl", distro: "Ubuntu", user: "developer" };

    const first = registry.connect({
      requestId: "request-first",
      target,
      remoteAssets: {},
    });
    registry.cancelConnect("request-first");
    await expect(first).rejects.toThrow("远程连接已取消");

    expect(observedSignals[0]?.aborted).toBe(false);
    const second = registry.connect({
      requestId: "request-second",
      target,
      remoteAssets: {},
    });
    expect(connect).toHaveBeenCalledTimes(1);

    pending.resolve(connection.handle);
    await expect(second).resolves.toMatchObject({
      remoteSessionId: "remote-session-2",
    });
    await registry.dispose();
  });

  it("Docker pending connect 取消不触发底层 abort，后续请求仍保持 dedicated", async () => {
    const firstPending = deferred<WindowRemoteConnectionHandle<string>>();
    const secondPending = deferred<WindowRemoteConnectionHandle<string>>();
    const firstConnection = createHandle("docker-first");
    const secondConnection = createHandle("docker-second");
    const observedSignals: AbortSignal[] = [];
    let connectId = 0;
    let sessionId = 0;
    const registry = createWindowRemoteConnectionRegistry({
      connect: (request) => {
        observedSignals.push(request.signal);
        connectId += 1;
        return connectId === 1 ? firstPending.promise : secondPending.promise;
      },
      createId: () => `remote-session-${++sessionId}`,
    });
    const target: RemoteTarget = { kind: "docker", container: "demo" };

    const first = registry.connect({
      requestId: "request-first",
      target,
      remoteAssets: {},
    });
    registry.cancelConnect("request-first");
    await expect(first).rejects.toThrow("远程连接已取消");
    expect(observedSignals[0]?.aborted).toBe(false);

    const second = registry.connect({
      requestId: "request-second",
      target,
      remoteAssets: {},
    });
    expect(observedSignals).toHaveLength(2);

    firstPending.resolve(firstConnection.handle);
    secondPending.resolve(secondConnection.handle);
    await expect(second).resolves.toMatchObject({
      remoteSessionId: "remote-session-2",
    });
    await Promise.resolve();

    expect(firstConnection.dispose).toHaveBeenCalledTimes(1);
    expect(secondConnection.dispose).not.toHaveBeenCalled();
    await registry.dispose();
  });

  it("取消复用 ready SSH cache 的 logical connect 不销毁窗口连接", async () => {
    const connection = createHandle("ssh-services");
    const connect = vi.fn(async () => connection.handle);
    let id = 0;
    const registry = createWindowRemoteConnectionRegistry({
      connect,
      createId: () => `remote-session-${++id}`,
    });
    const first = await registry.connect({
      requestId: "request-first",
      target: sshTarget,
      remoteAssets: {},
    });
    await registry.disposeSession(first.remoteSessionId);

    const cancelled = registry.connect({
      requestId: "request-cancelled",
      target: sshTarget,
      remoteAssets: {},
    });
    registry.cancelConnect("request-cancelled");
    await expect(cancelled).rejects.toThrow("远程连接已取消");

    expect(connection.dispose).not.toHaveBeenCalled();
    await registry.connect({
      requestId: "request-after-cancel",
      target: sshTarget,
      remoteAssets: {},
    });
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("scope 必须与 registry 中的 path 和 identity 完全一致", async () => {
    const registry = createWindowRemoteConnectionRegistry({
      connect: async () => createHandle("remote-services").handle,
      createId: () => "remote-session-1",
    });
    await registry.connect({
      requestId: "request-1",
      target: sshTarget,
      remoteAssets: {},
      workspacePath: "/work/demo",
      workspaceIdentity: "remote:ssh:dev:/work/demo",
    });

    expect(
      registry.resolveScopedServices({
        kind: "remote",
        remoteSessionId: "remote-session-1",
        workspacePath: "/work/demo",
        workspaceIdentity: "remote:ssh:dev:/work/demo",
      }),
    ).toBe("remote-services");
    expect(() =>
      registry.resolveScopedServices({
        kind: "remote",
        remoteSessionId: "remote-session-1",
        workspacePath: "/work/demo",
        workspaceIdentity: "remote:ssh:other:/work/demo",
      }),
    ).toThrow("远程 attachment scope 与 logical session 不匹配");
    expect(() =>
      registry.resolveScopedServices({
        kind: "remote",
        remoteSessionId: "remote-session-1",
        workspacePath: "/other",
        workspaceIdentity: "remote:ssh:dev:/work/demo",
      }),
    ).toThrow("远程 attachment scope 与 logical session 不匹配");
  });

  it("连接断开后保留 logical session 离线事实，但所有 scoped IO fail-closed", async () => {
    const connection = createHandle("remote-services");
    const closed = vi.fn();
    const registry = createWindowRemoteConnectionRegistry({
      connect: async () => connection.handle,
      createId: () => "remote-session-1",
      onSessionClosed: closed,
    });
    await registry.connect({
      requestId: "request-1",
      target: sshTarget,
      remoteAssets: {},
      workspacePath: "/work/demo",
      workspaceIdentity: "remote:ssh:dev:/work/demo",
    });

    connection.close();

    expect(registry.getSession("remote-session-1")).toMatchObject({
      sourceAvailability: "offline",
      state: "disconnected",
    });
    expect(() =>
      registry.resolveScopedServices({
        kind: "remote",
        remoteSessionId: "remote-session-1",
        workspacePath: "/work/demo",
        workspaceIdentity: "remote:ssh:dev:/work/demo",
      }),
    ).toThrow(WindowRemoteConnectionUnavailableError);
    expect(closed).toHaveBeenCalledWith(
      expect.objectContaining({ remoteSessionId: "remote-session-1" }),
    );
  });

  it("disposeSession 与 registry dispose 都是幂等的", async () => {
    const connection = createHandle("remote-services");
    const registry = createWindowRemoteConnectionRegistry({
      connect: async () => connection.handle,
      createId: () => "remote-session-1",
    });
    await registry.connect({ requestId: "request-1", target: sshTarget, remoteAssets: {} });

    await registry.disposeSession("remote-session-1");
    await registry.disposeSession("remote-session-1");
    await registry.dispose();
    await registry.dispose();

    expect(connection.dispose).toHaveBeenCalledTimes(1);
  });

  it("WSL 保留 60 秒 idle TTL，并由 running task protection 延迟释放", async () => {
    vi.useFakeTimers();
    const connection = createHandle("wsl-services");
    const registry = createWindowRemoteConnectionRegistry({
      connect: async () => connection.handle,
      createId: () => "remote-session-wsl",
      wslIdleTtlMs: 60_000,
    });
    await registry.connect({
      requestId: "request-wsl",
      target: { kind: "wsl", distro: "Ubuntu" },
      remoteAssets: {},
      workspacePath: "/work/demo",
      workspaceIdentity: "remote:wsl:Ubuntu:/work/demo",
    });
    registry.setWorkspaceRunningTaskCount({
      workspacePath: "/work/demo",
      workspaceIdentity: "remote:wsl:Ubuntu:/work/demo",
      runningTaskCount: 1,
    });
    await registry.disposeSession("remote-session-wsl");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(connection.dispose).not.toHaveBeenCalled();

    registry.setWorkspaceRunningTaskCount({
      workspacePath: "/work/demo",
      workspaceIdentity: "remote:wsl:Ubuntu:/work/demo",
      runningTaskCount: 0,
    });
    await vi.advanceTimersByTimeAsync(59_999);
    expect(connection.dispose).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(connection.dispose).toHaveBeenCalledTimes(1);
  });

  it("WSL 共享连接按 workspace 释放 runtime，不影响其他 logical session", async () => {
    const connection = createHandle("wsl-services");
    const releaseWorkspace = vi.fn(async () => undefined);
    let sessionId = 0;
    const registry = createWindowRemoteConnectionRegistry({
      connect: async () => connection.handle,
      createId: () => `remote-session-${++sessionId}`,
      releaseWorkspace,
    });
    const first = await registry.connect({
      requestId: "request-a",
      target: { kind: "wsl", distro: "Ubuntu" },
      remoteAssets: {},
      workspacePath: "/work/a",
      workspaceIdentity: "remote:wsl:Ubuntu:/work/a",
    });
    const second = await registry.connect({
      requestId: "request-b",
      target: { kind: "wsl", distro: "Ubuntu" },
      remoteAssets: {},
      workspacePath: "/work/b",
      workspaceIdentity: "remote:wsl:Ubuntu:/work/b",
    });

    await registry.disposeSession(first.remoteSessionId);

    expect(releaseWorkspace).toHaveBeenCalledWith("wsl-services", {
      workspacePath: "/work/a",
      workspaceIdentity: "remote:wsl:Ubuntu:/work/a",
    });
    expect(connection.dispose).not.toHaveBeenCalled();
    expect(registry.getSession(second.remoteSessionId)).toMatchObject({ state: "online" });
  });

  it("WSL workspace 有运行中 task 时延迟 runtime release，归零后再释放", async () => {
    const connection = createHandle("wsl-services");
    const releaseWorkspace = vi.fn(async () => undefined);
    const registry = createWindowRemoteConnectionRegistry({
      connect: async () => connection.handle,
      createId: () => "remote-session-wsl",
      releaseWorkspace,
    });
    const descriptor = await registry.connect({
      requestId: "request-wsl",
      target: { kind: "wsl", distro: "Ubuntu" },
      remoteAssets: {},
      workspacePath: "/work/demo",
      workspaceIdentity: "remote:wsl:Ubuntu:/work/demo",
    });
    registry.setWorkspaceRunningTaskCount({
      workspacePath: "/work/demo",
      workspaceIdentity: "remote:wsl:Ubuntu:/work/demo",
      runningTaskCount: 1,
    });

    await registry.disposeSession(descriptor.remoteSessionId);
    expect(releaseWorkspace).not.toHaveBeenCalled();

    registry.setWorkspaceRunningTaskCount({
      workspacePath: "/work/demo",
      workspaceIdentity: "remote:wsl:Ubuntu:/work/demo",
      runningTaskCount: 0,
    });
    await vi.waitFor(() => expect(releaseWorkspace).toHaveBeenCalledTimes(1));
  });

  it("WSL workspace 快速重开会使尚未开始的旧 generation release 失效", async () => {
    const connection = createHandle("wsl-services");
    const releaseWorkspace = vi.fn(async () => undefined);
    let sessionId = 0;
    const registry = createWindowRemoteConnectionRegistry({
      connect: async () => connection.handle,
      createId: () => `remote-session-${++sessionId}`,
      releaseWorkspace,
    });
    const context = {
      workspacePath: "/work/demo",
      workspaceIdentity: "remote:wsl:Ubuntu:/work/demo",
    };
    const first = await registry.connect({
      requestId: "request-1",
      target: { kind: "wsl", distro: "Ubuntu" },
      remoteAssets: {},
      ...context,
    });
    registry.setWorkspaceRunningTaskCount({ ...context, runningTaskCount: 1 });
    await registry.disposeSession(first.remoteSessionId);

    await registry.connect({
      requestId: "request-2",
      target: { kind: "wsl", distro: "Ubuntu" },
      remoteAssets: {},
      ...context,
    });
    registry.setWorkspaceRunningTaskCount({ ...context, runningTaskCount: 0 });
    await Promise.resolve();

    expect(releaseWorkspace).not.toHaveBeenCalled();
  });

  it("WSL workspace 重开会等待上一代 in-flight release 完成", async () => {
    const connection = createHandle("wsl-services");
    const release = deferred<void>();
    const releaseWorkspace = vi.fn(() => release.promise);
    let sessionId = 0;
    const registry = createWindowRemoteConnectionRegistry({
      connect: async () => connection.handle,
      createId: () => `remote-session-${++sessionId}`,
      releaseWorkspace,
    });
    const context = {
      workspacePath: "/work/demo",
      workspaceIdentity: "remote:wsl:Ubuntu:/work/demo",
    };
    const first = await registry.connect({
      requestId: "request-1",
      target: { kind: "wsl", distro: "Ubuntu" },
      remoteAssets: {},
      ...context,
    });

    const dispose = registry.disposeSession(first.remoteSessionId);
    await vi.waitFor(() => expect(releaseWorkspace).toHaveBeenCalledTimes(1));
    let connected = false;
    const reconnect = registry
      .connect({
        requestId: "request-2",
        target: { kind: "wsl", distro: "Ubuntu" },
        remoteAssets: {},
        ...context,
      })
      .then(() => {
        connected = true;
      });
    await Promise.resolve();
    expect(connected).toBe(false);

    release.resolve();
    await Promise.all([dispose, reconnect]);
    expect(connected).toBe(true);
  });

  it("WSL target-only session 补绑 context 后等待 generation barrier 再暴露 scoped services", async () => {
    const connection = createHandle("wsl-services");
    const release = deferred<void>();
    const releaseWorkspace = vi.fn(() => release.promise);
    let sessionId = 0;
    const registry = createWindowRemoteConnectionRegistry({
      connect: async () => connection.handle,
      createId: () => `remote-session-${++sessionId}`,
      releaseWorkspace,
    });
    const target = { kind: "wsl", distro: "Ubuntu", user: "ai" } as const;
    const context = {
      workspacePath: "/home/ai/projects",
      workspaceIdentity: "remote:wsl:Ubuntu:ai:/home/ai/projects",
    };
    const first = await registry.connect({
      requestId: "request-first",
      target,
      remoteAssets: {},
      ...context,
    });
    const disposeFirst = registry.disposeSession(first.remoteSessionId);
    await vi.waitFor(() => expect(releaseWorkspace).toHaveBeenCalledOnce());

    const targetOnly = await registry.connect({
      requestId: "request-target-only",
      target,
      remoteAssets: {},
    });
    const bind = registry.bindWorkspaceContext({
      remoteSessionId: targetOnly.remoteSessionId,
      ...context,
    });
    const attach = registry.waitForScopedServices({
      kind: "remote",
      remoteSessionId: targetOnly.remoteSessionId,
      ...context,
    });

    // Bug 根因：3.7.7 在 WSL session 创建后补绑 context 时没有建立 workspace generation。
    // scoped attachment 必须复用 bind 创建的 barrier，不能在上一代 runtime 释放完成前暴露服务。
    // 单次 microtask 让出无法区分真实 barrier 与 async Promise 的普通 continuation；等待到
    // setImmediate 会排空当前 microtask 队列，使错误的立即完成实现稳定返回 ready。
    const attachmentState = await Promise.race([
      attach.then(
        () => "ready" as const,
        () => "failed" as const,
      ),
      new Promise<"pending">((resolve) => setImmediate(() => resolve("pending"))),
    ]);

    // 先释放 deferred 并收敛所有 Promise，再做负向断言；即使发生回归，case 也不会遗留挂起任务。
    release.resolve();
    await expect(attach).resolves.toBe("wsl-services");
    await Promise.all([disposeFirst, bind]);
    expect(attachmentState).toBe("pending");
  });
});
