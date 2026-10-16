import { describe, it, expect } from "vitest";
import { ProxyChannel } from "../src/proxy-channel.js";
import { ChannelServer, ChannelClient } from "../src/channels.js";
import { createQueuePair } from "../src/protocol.js";
import { Emitter, Event } from "../src/foundation.js";

interface ITestService {
  greet(name: string): Promise<string>;
  add(a: number, b: number): Promise<number>;
  onDidChange: Event<string>;
}

function createServicePair<T extends object>(service: unknown) {
  const [serverProtocol, clientProtocol] = createQueuePair();
  const server = new ChannelServer(serverProtocol, "ctx");
  const client = new ChannelClient(clientProtocol);

  const serverChannel = ProxyChannel.fromService(service);
  server.registerChannel("svc", serverChannel);

  const ch = client.getChannel("svc");
  const proxy = ProxyChannel.toService<T>(ch);

  return { proxy, server, client, dispose: () => { server.dispose(); client.dispose(); } };
}

describe("ProxyChannel", () => {
  it("should proxy method calls", async () => {
    const service = {
      greet(name: string) {
        return Promise.resolve(`Hello, ${name}!`);
      },
      add(a: number, b: number) {
        return Promise.resolve(a + b);
      },
      onDidChange: Event.None,
    };

    const { proxy, dispose } = createServicePair<ITestService>(service);

    expect(await proxy.greet("world")).toBe("Hello, world!");
    expect(await proxy.add(2, 3)).toBe(5);
    dispose();
  });

  it("should proxy events", async () => {
    const emitter = new Emitter<string>();
    const service = {
      onDidChange: emitter.event,
    };

    const { proxy, dispose } = createServicePair<{ onDidChange: Event<string> }>(service);

    const values: string[] = [];
    const received = new Promise<void>((resolve) => {
      proxy.onDidChange((v) => {
        values.push(v);
        if (values.length === 2) resolve();
      });
    });

    await new Promise((r) => setTimeout(r, 50));
    emitter.fire("change1");
    emitter.fire("change2");

    await received;
    expect(values).toEqual(["change1", "change2"]);
    dispose();
  });

  it("should proxy dynamic events with arguments", async () => {
    const emitter = new Emitter<string>();
    const calls: unknown[] = [];
    const service = {
      onDynamicSessionEvent(params: unknown) {
        calls.push(params);
        return emitter.event;
      },
    };

    const { proxy, dispose } = createServicePair<{
      onDynamicSessionEvent(params: unknown): Event<string>;
    }>(service);

    const values: string[] = [];
    let disposable: { dispose(): void } | undefined;
    const received = new Promise<void>((resolve) => {
      disposable = proxy.onDynamicSessionEvent({ sessionId: "sess_1" })((value) => {
        values.push(value);
        resolve();
      });
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    emitter.fire("ready");
    await received;

    expect(calls).toEqual([{ sessionId: "sess_1" }]);
    expect(values).toEqual(["ready"]);
    disposable?.dispose();
    dispose();
  });

  it("should proxy sync methods as async", async () => {
    const service = {
      syncMethod() {
        return 42;
      },
    };

    const { proxy, dispose } = createServicePair<{ syncMethod(): Promise<number> }>(service);
    const result = await proxy.syncMethod();
    expect(result).toBe(42);
    dispose();
  });

  it("should preserve nested Uint8Array values across method arguments and returns", async () => {
    const received: Array<boolean> = [];
    const service = {
      exportArchive() {
        return Promise.resolve({
          archive: new Uint8Array([31, 139, 8, 0]),
        });
      },
      importArchive(params: { archive: Uint8Array }) {
        received.push(params.archive instanceof Uint8Array);
        return Promise.resolve([...params.archive]);
      },
    };

    const { proxy, dispose } = createServicePair<{
      exportArchive(): Promise<{ archive: Uint8Array }>;
      importArchive(params: { archive: Uint8Array }): Promise<number[]>;
    }>(service);

    const exported = await proxy.exportArchive();
    expect(exported.archive).toBeInstanceOf(Uint8Array);
    expect([...exported.archive]).toEqual([31, 139, 8, 0]);

    await expect(
      proxy.importArchive({ archive: new Uint8Array([1, 2, 3]) }),
    ).resolves.toEqual([1, 2, 3]);
    expect(received).toEqual([true]);
    dispose();
  });

  it("fromService should throw for unknown events", () => {
    const channel = ProxyChannel.fromService({});
    expect(() => channel.listen("ctx" as any, "onNotExist")).toThrow("Event not found");
  });

  it("fromService should throw for unknown methods", () => {
    const channel = ProxyChannel.fromService({});
    expect(() => channel.call("ctx", "notAMethod")).toThrow("Method not found");
  });

  it("toService should allow runtime symbol introspection", () => {
    const service = {
      ping() {
        return Promise.resolve("pong");
      },
    };

    const { proxy, dispose } = createServicePair<{ ping(): Promise<string> }>(service);

    expect(() => Object.prototype.toString.call(proxy)).not.toThrow();
    expect(Object.prototype.toString.call(proxy)).toBe("[object Object]");
    dispose();
  });

  it("toService should not look like a thenable", () => {
    const service = {
      ping() {
        return Promise.resolve("pong");
      },
    };

    const { proxy, dispose } = createServicePair<{ ping(): Promise<string> }>(service);

    expect((proxy as { then?: unknown }).then).toBeUndefined();
    dispose();
  });
});
