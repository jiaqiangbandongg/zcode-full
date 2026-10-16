import { describe, expect, it, vi } from "vitest";
import {
  createDesktopContextPromptRollout,
  resolveDesktopContextPromptConfig,
} from "../src/main/desktopContextPromptRollout.js";

function config(enabled: boolean, configVersion = "desktop-sp-v1") {
  return {
    code: 0,
    data: {
      configs: {
        desktopContextPrompt: {
          enabled,
          config_version: configVersion,
        },
      },
    },
  };
}

describe("desktopContextPromptRollout", () => {
  it("只接受 code=0 且 enabled 为 boolean 的 Desktop SP 配置", () => {
    expect(resolveDesktopContextPromptConfig(config(true))).toEqual({
      enabled: true,
      configVersion: "desktop-sp-v1",
    });
    expect(resolveDesktopContextPromptConfig(config(false, "v2"))).toEqual({
      enabled: false,
      configVersion: "v2",
    });
    expect(resolveDesktopContextPromptConfig({ code: 500, data: config(true).data })).toBeNull();
    expect(
      resolveDesktopContextPromptConfig({ success: false, data: config(true).data }),
    ).toBeNull();
    expect(
      resolveDesktopContextPromptConfig({ code: 0, data: { configs: {} } }),
    ).toEqual({ enabled: false });
    expect(
      resolveDesktopContextPromptConfig({
        code: 0,
        data: { configs: { desktopContextPrompt: { enabled: "true" } } },
      }),
    ).toBeNull();
  });

  it("服务端成功响应但未下发配置时覆盖旧缓存并按关闭处理", async () => {
    vi.useFakeTimers();
    try {
      const fetchConfig = vi
        .fn<(_: AbortSignal) => Promise<unknown>>()
        .mockResolvedValueOnce(config(true))
        .mockResolvedValueOnce({ code: 0, data: { configs: {} } });
      const rollout = createDesktopContextPromptRollout({
        fetchConfig,
        logger: { warn: vi.fn() },
        cacheTtlMs: 1,
      });

      await expect(rollout.refresh()).resolves.toEqual({
        enabled: true,
        configVersion: "desktop-sp-v1",
      });
      await vi.advanceTimersByTimeAsync(1);
      await expect(rollout.refresh()).resolves.toEqual({ enabled: false });
      expect(rollout.getSnapshot()).toEqual({ enabled: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it("首次请求失败时默认关闭，且不会阻塞读取结果", async () => {
    const rollout = createDesktopContextPromptRollout({
      fetchConfig: vi.fn(async () => {
        throw new Error("offline");
      }),
      logger: { warn: vi.fn() },
    });

    await expect(rollout.refresh()).resolves.toEqual({ enabled: false });
    expect(rollout.getSnapshot()).toEqual({ enabled: false });
  });

  it("请求超过 3 秒时复用最近一次成功结果", async () => {
    vi.useFakeTimers();
    try {
      let resolveRequest!: (value: unknown) => void;
      const fetchConfig = vi
        .fn<(_: AbortSignal) => Promise<unknown>>()
        .mockResolvedValueOnce(config(true))
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveRequest = resolve;
            }),
        );
      const rollout = createDesktopContextPromptRollout({
        fetchConfig,
        logger: { warn: vi.fn() },
        cacheTtlMs: 1,
      });

      await expect(rollout.refresh()).resolves.toEqual({
        enabled: true,
        configVersion: "desktop-sp-v1",
      });
      await vi.advanceTimersByTimeAsync(1);
      const pending = rollout.refresh();
      await vi.advanceTimersByTimeAsync(3_000);
      await expect(pending).resolves.toEqual({
        enabled: true,
        configVersion: "desktop-sp-v1",
      });

      // A late response from the timed-out request must not overwrite the cached decision.
      resolveRequest(config(false, "late"));
      await Promise.resolve();
      expect(rollout.getSnapshot()).toEqual({
        enabled: true,
        configVersion: "desktop-sp-v1",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("成功结果在一小时 TTL 内直接复用，过期后才重新请求", async () => {
    vi.useFakeTimers();
    try {
      const fetchConfig = vi
        .fn<(_: AbortSignal) => Promise<unknown>>()
        .mockResolvedValueOnce(config(true))
        .mockResolvedValueOnce(config(false, "desktop-sp-v2"));
      const rollout = createDesktopContextPromptRollout({
        fetchConfig,
        logger: { warn: vi.fn() },
      });

      await expect(rollout.refresh()).resolves.toEqual({
        enabled: true,
        configVersion: "desktop-sp-v1",
      });
      await expect(rollout.refresh()).resolves.toEqual({
        enabled: true,
        configVersion: "desktop-sp-v1",
      });
      expect(fetchConfig).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(60 * 60 * 1_000);
      await expect(rollout.refresh()).resolves.toEqual({
        enabled: false,
        configVersion: "desktop-sp-v2",
      });
      expect(fetchConfig).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("复用同一轮 in-flight 请求，避免重复访问配置接口", async () => {
    let resolveRequest!: (value: unknown) => void;
    const fetchConfig = vi.fn(
      () =>
        new Promise<unknown>((resolve) => {
          resolveRequest = resolve;
        }),
    );
    const rollout = createDesktopContextPromptRollout({
      fetchConfig,
      logger: { warn: vi.fn() },
    });

    const first = rollout.refresh();
    const second = rollout.refresh();
    expect(fetchConfig).toHaveBeenCalledOnce();
    resolveRequest(config(true));
    await expect(Promise.all([first, second])).resolves.toEqual([
      { enabled: true, configVersion: "desktop-sp-v1" },
      { enabled: true, configVersion: "desktop-sp-v1" },
    ]);
  });

  it("awaitFirstDecision 在超时窗口内拿到服务端真值", async () => {
    vi.useFakeTimers();
    try {
      const fetchConfig = vi
        .fn<(_: AbortSignal) => Promise<unknown>>()
        .mockImplementation(
          () =>
            new Promise((resolve) => {
              setTimeout(() => resolve(config(true)), 100);
            }),
        );
      const rollout = createDesktopContextPromptRollout({
        fetchConfig,
        logger: { warn: vi.fn() },
      });

      const pending = rollout.awaitFirstDecision(2_000);
      await vi.advanceTimersByTimeAsync(100);
      await expect(pending).resolves.toEqual({
        enabled: true,
        configVersion: "desktop-sp-v1",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("awaitFirstDecision 超时回退当前快照，并发调用结果一致，且不阻塞后台请求更新", async () => {
    vi.useFakeTimers();
    try {
      const fetchConfig = vi
        .fn<(_: AbortSignal) => Promise<unknown>>()
        .mockImplementation(
          () =>
            new Promise((resolve) => {
              setTimeout(() => resolve(config(true)), 200);
            }),
        );
      const rollout = createDesktopContextPromptRollout({
        fetchConfig,
        logger: { warn: vi.fn() },
      });

      const first = rollout.awaitFirstDecision(50);
      const second = rollout.awaitFirstDecision(50);
      await vi.advanceTimersByTimeAsync(50);
      await expect(first).resolves.toEqual({ enabled: false });
      await expect(second).resolves.toEqual({ enabled: false });

      // 超时回退不应阻止后台请求最终把真值写入快照——后续 Host fork 同步读取即可命中。
      await vi.advanceTimersByTimeAsync(150);
      expect(rollout.getSnapshot()).toEqual({
        enabled: true,
        configVersion: "desktop-sp-v1",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("首个 Host spawn 前的有界等待：慢响应成功 enabled=true 后同步读取快照为真值", async () => {
    // CR-01 集成式回归：模拟 Main 端 bootstrap 预热 + 首个 Host fork 前的 bounded await，
    // 证明"慢响应但成功返回 enabled=true 时，首 Host 最终以 desktop surface 启动"。
    vi.useFakeTimers();
    try {
      const fetchConfig = vi
        .fn<(_: AbortSignal) => Promise<unknown>>()
        .mockImplementation(
          () =>
            new Promise((resolve) => {
              setTimeout(() => resolve(config(true)), 100);
            }),
        );
      const rollout = createDesktopContextPromptRollout({
        fetchConfig,
        logger: { warn: vi.fn() },
      });

      // 1) Main 端 bootstrap 预热：发请求但不 await（fire-and-forget，尽早开始网络往返）
      void rollout.refresh();
      // 2) 首个 Host fork 前 bounded await（≤ timeoutMs），复用 in-flight 请求
      const decision = rollout.awaitFirstDecision(2_000);
      await vi.advanceTimersByTimeAsync(100);
      await decision;
      // 3) 此刻 resolveDesktopContextPromptEnabledForHost() 同步读取应得真值——首 Host env 写 "1"
      expect(rollout.getSnapshot().enabled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
