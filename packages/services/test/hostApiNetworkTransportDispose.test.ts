import { describe, expect, it, vi } from "vitest";
import { ServiceCollection } from "../src/collection.js";
import {
  disposeServiceResources,
  disposeServiceResourcesAndWait,
  registerHostApiNetworkTransportForDispose,
} from "../src/node.js";

function createTransportDouble() {
  return {
    fetch: vi.fn() as unknown as typeof fetch,
    dispose: vi.fn(),
    disposeAndWait: vi.fn(async () => {}),
  };
}

describe("Host API network transport lifecycle", () => {
  it("同步 Host dispose 会 best-effort 销毁 transport", () => {
    const services = new ServiceCollection();
    const transport = createTransportDouble();
    registerHostApiNetworkTransportForDispose(services, transport);

    disposeServiceResources(services);

    expect(transport.dispose).toHaveBeenCalledOnce();
    expect(transport.disposeAndWait).not.toHaveBeenCalled();
  });

  it("等待式 Host dispose 会等待 transport 关闭", async () => {
    const services = new ServiceCollection();
    const transport = createTransportDouble();
    registerHostApiNetworkTransportForDispose(services, transport);

    await disposeServiceResourcesAndWait(services);

    expect(transport.disposeAndWait).toHaveBeenCalledOnce();
    expect(transport.dispose).not.toHaveBeenCalled();
  });
});
