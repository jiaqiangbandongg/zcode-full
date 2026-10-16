import { afterEach, describe, expect, it, vi } from "vitest";
import type { Dispatcher } from "undici";
import {
  createHostApiNetworkTransport,
  mergeHostApiCaCertificates,
  resolveHostProxyForUrl,
  type HostApiNetworkTransport,
} from "../src/providers/api/nodeApiNetwork.js";

function createDispatcherDouble() {
  return {
    close: vi.fn(async () => {}),
    destroy: vi.fn(),
  } as unknown as Dispatcher;
}

describe("Host API proxy routing", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("未配置代理时保持直连", () => {
    expect(resolveHostProxyForUrl("https://api.example.com/v1", {})).toEqual({
      kind: "direct",
    });
  });

  it("代理配置按最终 URL 的 No Proxy 规则选择出口", () => {
    expect(
      resolveHostProxyForUrl("https://api.example.com/v1", {
        httpProxy: "http://proxy.example.com:8080",
        noProxy: ".example.com",
      }),
    ).toEqual({ kind: "direct", noProxyMatched: true });
    expect(
      resolveHostProxyForUrl("https://zcode.ai/v1", {
        httpProxy: "http://proxy.example.com:8080",
        noProxy: ".example.com",
      }),
    ).toEqual({ kind: "proxy", proxyUrl: "http://proxy.example.com:8080/" });
  });

  it("支持精确 host:port 和通配符规则", () => {
    const options = {
      httpProxy: "http://proxy.example.com:8080",
      noProxy: "api.example.com:443,*.internal",
    };
    expect(resolveHostProxyForUrl("https://api.example.com/v1", options)).toMatchObject({
      kind: "direct",
      noProxyMatched: true,
    });
    expect(resolveHostProxyForUrl("http://service.internal/v1", options)).toMatchObject({
      kind: "direct",
      noProxyMatched: true,
    });
  });

  it("显式代理配置无效时 fail closed，不回退到直连", async () => {
    const directFetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("direct", { status: 200 }));
    const transport = createHostApiNetworkTransport(async () => ({ httpProxy: "not a proxy" }));

    await expect(transport.fetch("https://api.example.com/v1")).rejects.toThrow(
      "Configured Host proxy URL is invalid",
    );
    expect(directFetch).not.toHaveBeenCalled();
  });

  it("在 Host 生命周期内只读取一次设置", async () => {
    const resolveOptions = vi.fn(async () => ({}));
    const directFetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("direct", { status: 200 }));
    const transport = createHostApiNetworkTransport(resolveOptions);

    await transport.fetch("https://api.example.com/one");
    await transport.fetch("https://api.example.com/two");

    expect(resolveOptions).toHaveBeenCalledOnce();
    expect(directFetch).toHaveBeenCalledTimes(2);
  });

  it("设置读取失败不会永久缓存 rejected promise，后续请求可重试", async () => {
    const resolveOptions = vi
      .fn<() => Promise<{ httpProxy?: string }>>()
      .mockRejectedValueOnce(new Error("settings unavailable"))
      .mockResolvedValueOnce({});
    const directFetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("direct", { status: 200 }));
    const transport = createHostApiNetworkTransport(resolveOptions);

    await expect(transport.fetch("https://api.example.com/first")).rejects.toThrow(
      "settings unavailable",
    );
    await expect(transport.fetch("https://api.example.com/second")).resolves.toBeInstanceOf(
      Response,
    );

    expect(resolveOptions).toHaveBeenCalledTimes(2);
    expect(directFetch).toHaveBeenCalledOnce();
  });

  it("自定义代理 CA 不替换 Node 默认根证书", () => {
    const merged = mergeHostApiCaCertificates("custom-ca", ["default-ca"]);

    expect(merged).toEqual(["default-ca", "custom-ca"]);
  });

  it("等待式释放关闭 Host 生命周期内复用的 dispatcher", async () => {
    const dispatcher = createDispatcherDouble();
    const createDispatcher = vi.fn(async () => dispatcher);
    const fetchWithDispatcher = vi.fn(async () => new Response("proxied"));
    const transport = createHostApiNetworkTransport(
      async () => ({ httpProxy: "http://proxy.example.com:8080" }),
      { createDispatcher, fetchWithDispatcher },
    );

    await transport.fetch("https://api.example.com/one");
    await transport.fetch("https://api.example.com/two");
    await transport.disposeAndWait();
    await transport.disposeAndWait();

    expect(createDispatcher).toHaveBeenCalledOnce();
    expect(fetchWithDispatcher).toHaveBeenCalledTimes(2);
    expect(dispatcher.close).toHaveBeenCalledOnce();
    expect(dispatcher.destroy).not.toHaveBeenCalled();
  });

  it("dispatcher 初始化失败不会永久缓存 rejected promise，后续请求可重试", async () => {
    const dispatcher = createDispatcherDouble();
    const createDispatcher = vi
      .fn<() => Promise<Dispatcher>>()
      .mockRejectedValueOnce(new Error("CA unavailable"))
      .mockResolvedValueOnce(dispatcher);
    const fetchWithDispatcher = vi.fn(async () => new Response("proxied"));
    const transport = createHostApiNetworkTransport(
      async () => ({ httpProxy: "http://proxy.example.com:8080", caCertPath: "/tmp/ca.pem" }),
      { createDispatcher, fetchWithDispatcher },
    );

    await expect(transport.fetch("https://api.example.com/first")).rejects.toThrow(
      "CA unavailable",
    );
    await expect(transport.fetch("https://api.example.com/second")).resolves.toBeInstanceOf(
      Response,
    );

    expect(createDispatcher).toHaveBeenCalledTimes(2);
    expect(fetchWithDispatcher).toHaveBeenCalledOnce();
  });

  it("dispatcher 创建与 dispose 竞态时仍会销毁晚到的 dispatcher", async () => {
    const dispatcher = createDispatcherDouble();
    let transport!: HostApiNetworkTransport;
    const createDispatcher = vi.fn(async () => {
      transport.dispose();
      return dispatcher;
    });
    transport = createHostApiNetworkTransport(
      async () => ({ httpProxy: "http://proxy.example.com:8080" }),
      { createDispatcher, fetchWithDispatcher: async () => new Response("proxied") },
    );

    await expect(transport.fetch("https://api.example.com/race")).rejects.toThrow(
      "Host API network transport has been disposed",
    );
    await Promise.resolve();

    expect(createDispatcher).toHaveBeenCalledOnce();
    expect(dispatcher.destroy).toHaveBeenCalledOnce();
  });

  it("等待式 dispose 会等待竞态 dispatcher 的关闭完成", async () => {
    const dispatcher = createDispatcherDouble();
    let resolveClose!: () => void;
    dispatcher.close = vi.fn(
      () => new Promise<void>((resolve) => (resolveClose = resolve)),
    ) as unknown as Dispatcher["close"];
    let resolveDispatcher!: (value: Dispatcher) => void;
    const dispatcherPromise = new Promise<Dispatcher>((resolve) => {
      resolveDispatcher = resolve;
    });
    let resolveFactoryStarted!: () => void;
    const factoryStarted = new Promise<void>((resolve) => {
      resolveFactoryStarted = resolve;
    });
    let transport!: HostApiNetworkTransport;
    let disposeAndWaitPromise!: Promise<void>;
    const createDispatcher = vi.fn(() => {
      resolveFactoryStarted();
      disposeAndWaitPromise = transport.disposeAndWait();
      return dispatcherPromise;
    });
    transport = createHostApiNetworkTransport(
      async () => ({ httpProxy: "http://proxy.example.com:8080" }),
      { createDispatcher, fetchWithDispatcher: async () => new Response("proxied") },
    );

    const fetchPromise = transport
      .fetch("https://api.example.com/race")
      .then(() => undefined, (error: unknown) => error);
    await factoryStarted;
    resolveDispatcher(dispatcher);
    await vi.waitFor(() => expect(dispatcher.close).toHaveBeenCalledOnce());
    expect(dispatcher.close).toHaveBeenCalledOnce();
    const disposeFinished = Promise.race([
      disposeAndWaitPromise.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 0)),
    ]);
    await expect(disposeFinished).resolves.toBe(false);
    resolveClose();
    await disposeAndWaitPromise;
    await expect(fetchPromise).resolves.toMatchObject({ message: expect.stringContaining("disposed") });
  });

  it("同步释放 best-effort 销毁 dispatcher，并拒绝释放后的新请求", async () => {
    const dispatcher = createDispatcherDouble();
    const directFetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("direct", { status: 200 }));
    const transport = createHostApiNetworkTransport(
      async () => ({ httpProxy: "http://proxy.example.com:8080" }),
      {
        createDispatcher: async () => dispatcher,
        fetchWithDispatcher: async () => new Response("proxied"),
      },
    );

    await transport.fetch("https://api.example.com/one");
    transport.dispose();
    await expect(transport.fetch("https://api.example.com/two")).rejects.toThrow(
      "Host API network transport has been disposed",
    );

    expect(dispatcher.destroy).toHaveBeenCalledOnce();
    expect(dispatcher.close).not.toHaveBeenCalled();
    expect(directFetch).not.toHaveBeenCalled();
  });
});
