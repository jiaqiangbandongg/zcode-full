import { describe, expect, it, vi } from "vitest";
import type { WebRemoteControlWindowBootstrapResult } from "@zcode/shared";
import {
  createWebRemoteControlTaskViewPublisher,
  createWebRemoteControlVersionGuard,
} from "#src/web-remote-control/index.js";

const bootstrap = (desktopAppVersion?: string): WebRemoteControlWindowBootstrapResult => ({
  windowControlSessionId: "device-1",
  workspaces: [],
  tasks: [],
  ...(desktopAppVersion === undefined ? {} : { desktopAppVersion }),
});

function harness(options: { url?: string; ready?: boolean; version?: string } = {}) {
  const requestBootstrap = vi.fn(async () => bootstrap(options.version));
  const navigate = vi.fn();
  const onMismatch = vi.fn();
  const onAccepted = vi.fn();
  const url =
    options.url ?? "https://zcode.z.ai/remote/v4?sid=a&hash=x%2By&t=1&app_version=3.12.1#task";
  const guard = createWebRemoteControlVersionGuard({
    requestBootstrap,
    getUrl: () => url,
    isPageReady: () => options.ready ?? false,
    navigate,
    onMismatch,
    onAccepted,
  });
  return { guard, requestBootstrap, navigate, onMismatch, onAccepted, url };
}

describe("remote v4 desktop version guard", () => {
  it("corrects the first URL before allowing business bootstrap, preserving connection parameters", async () => {
    const h = harness({ version: "3.12.2" });
    expect(await h.guard.check()).toBeUndefined();
    expect(h.navigate).toHaveBeenCalledExactlyOnceWith(h.url.replace("3.12.1", "3.12.2"));
    expect(h.onMismatch).not.toHaveBeenCalled();
    expect(h.onAccepted).not.toHaveBeenCalled();
    expect(h.guard.isBlocked()).toBe(true);
    await h.guard.check();
    h.guard.confirm();
    expect(h.navigate).toHaveBeenCalledTimes(1);
  });

  it("fills a missing version and accepts the v4 trailing slash", async () => {
    const h = harness({ url: "https://zcode.z.ai/remote/v4/?sid=a", version: "3.12.2" });
    await h.guard.check();
    expect(h.navigate).toHaveBeenCalledWith(
      "https://zcode.z.ai/remote/v4/?sid=a&app_version=3.12.2",
    );
  });

  it.each([undefined, "3.12.1"])(
    "continues with an old desktop or equal version: %s",
    async (version) => {
      const h = harness({ version });
      expect(await h.guard.check()).toEqual(bootstrap(version));
      expect(h.navigate).not.toHaveBeenCalled();
      expect(h.guard.isBlocked()).toBe(false);
      expect(h.onAccepted).toHaveBeenCalledExactlyOnceWith(bootstrap(version));
    },
  );

  it.each(["/remote", "/remote/v3", "/custom/remote"])(
    "does not redirect other entry points: %s",
    async (path) => {
      const h = harness({ url: `http://localhost:5173${path}?app_version=old`, version: "3.12.2" });
      expect(await h.guard.check()).toEqual(bootstrap("3.12.2"));
      expect(h.navigate).not.toHaveBeenCalled();
      expect(h.onAccepted).toHaveBeenCalledExactlyOnceWith(bootstrap("3.12.2"));
    },
  );

  it("keeps the active page and URL until confirmation, then navigates once", async () => {
    const h = harness({ ready: true, version: "3.12.2" });
    expect(await h.guard.check()).toBeUndefined();
    expect(h.onMismatch).toHaveBeenCalledExactlyOnceWith("3.12.2");
    expect(h.navigate).not.toHaveBeenCalled();
    expect(h.onAccepted).not.toHaveBeenCalled();
    await h.guard.check();
    h.guard.confirm();
    h.guard.confirm();
    expect(h.navigate).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent checks and checks again after recovery", async () => {
    const h = harness({ version: "3.12.1" });
    await Promise.all([h.guard.check(), h.guard.check()]);
    expect(h.requestBootstrap).toHaveBeenCalledTimes(1);
    expect(h.onAccepted).toHaveBeenCalledTimes(1);
    h.guard.invalidate();
    await h.guard.check();
    expect(h.requestBootstrap).toHaveBeenCalledTimes(2);
    expect(h.onAccepted).toHaveBeenCalledTimes(2);
  });

  it("ignores a late version from an obsolete connection", async () => {
    const h = harness({ version: "3.12.1" });
    let resolveOld!: (value: WebRemoteControlWindowBootstrapResult) => void;
    h.requestBootstrap.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    );
    const old = h.guard.check();
    h.guard.invalidate();
    expect(await h.guard.check()).toEqual(bootstrap("3.12.1"));
    resolveOld(bootstrap("3.12.2"));
    expect(await old).toBeUndefined();
    expect(h.navigate).not.toHaveBeenCalled();
    expect(h.onAccepted).toHaveBeenCalledExactlyOnceWith(bootstrap("3.12.1"));
  });

  it.each([false, true])(
    "MRO03：旧回包先到不能占用新配对的查看 epoch，重申先到=%s",
    async (reasserted) => {
      const h = harness({ version: "3.12.1" });
      const send = vi.fn(() => true);
      const publisher = createWebRemoteControlTaskViewPublisher(send);
      const bridge = {
        kind: "local" as const,
        bridgeSessionId: "bridge",
        workspaceKey: "/repo",
        workspacePath: "/repo",
      };
      publisher.setBridge(bridge);
      publisher.update(bridge, { workspacePath: "/repo", taskId: "task" });
      h.onAccepted.mockImplementation((result: WebRemoteControlWindowBootstrapResult) =>
        publisher.seed(result.mobileTaskViewEpoch),
      );
      const oldResult = { ...bootstrap("3.12.1"), mobileTaskViewEpoch: "E1" };
      const newResult = { ...bootstrap("3.12.1"), mobileTaskViewEpoch: "E2" };
      const oldResponse = Promise.withResolvers<WebRemoteControlWindowBootstrapResult>();
      h.requestBootstrap.mockReturnValueOnce(oldResponse.promise).mockResolvedValue(newResult);
      const old = h.guard.check();
      await Promise.resolve();
      // 同 socket 的 waiting -> paired 也撤销原请求；不能仅校验物理 socket。
      publisher.transportStateChanged("waiting", "paired");
      h.guard.invalidate();
      publisher.transportStateChanged("paired", "waiting");
      if (reasserted) publisher.request("E2");
      oldResponse.resolve(oldResult);
      expect(await old).toBeUndefined();
      expect(h.onAccepted).not.toHaveBeenCalled();
      expect(await h.guard.check()).toEqual(newResult);
      expect(h.onAccepted).toHaveBeenCalledExactlyOnceWith(newResult);
      expect(send).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          epoch: "E2",
          seq: 1,
          view: { workspacePath: "/repo", taskId: "task" },
        }),
      );
    },
  );

  it("does not accept an in-flight bootstrap after disposal", async () => {
    const h = harness();
    const response = Promise.withResolvers<WebRemoteControlWindowBootstrapResult>();
    h.requestBootstrap.mockReturnValueOnce(response.promise);
    const pending = h.guard.check();
    await Promise.resolve();
    h.guard.dispose();
    response.resolve(bootstrap());
    expect(await pending).toBeUndefined();
    expect(h.onAccepted).not.toHaveBeenCalled();
  });

  it("suppresses obsolete errors but propagates current failures", async () => {
    const h = harness();
    let rejectOld!: (error: Error) => void;
    h.requestBootstrap.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectOld = reject;
        }),
    );
    const old = h.guard.check();
    await Promise.resolve();
    h.guard.invalidate();
    rejectOld(new Error("old connection"));
    expect(await old).toBeUndefined();
    h.requestBootstrap.mockRejectedValueOnce(new Error("current connection"));
    await expect(h.guard.check()).rejects.toThrow("current connection");
  });

  it("does not navigate after disposal or leak pending state to another device", async () => {
    const first = harness({ ready: true, version: "3.12.2" });
    await first.guard.check();
    first.guard.dispose();
    first.guard.confirm();
    expect(first.navigate).not.toHaveBeenCalled();
    const second = harness({ version: "3.12.1" });
    expect(await second.guard.check()).toEqual(bootstrap("3.12.1"));
  });
});
