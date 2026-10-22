import { BufferReader, BufferWriter, deserialize, serialize, VSBuffer } from "@zcode/rpc";
import { PlatformChannels, ServiceChannels } from "@zcode/shared";

type Handler = (...args: unknown[]) => Promise<unknown>;
declare global {
  var __boundaryConnection: { held: boolean; release(): void; restore(): void } | undefined;
  interface Window {
    __boundarySetting?: {
      requests: number[][];
      stop(): number[][];
      release(prefixes: number[][][]): Promise<void>;
      restore(): void;
    };
  }
}

/** 真实 SSH 已完成后暂挂返回，精确覆盖取消确认与连接完成的交错。 */
export async function holdBoundaryConnection() {
  await browser.electron.execute((electron, channel) => {
    const handlers = (electron.ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })
      ._invokeHandlers;
    const original = handlers.get(channel);
    if (!original) throw new Error("Remote connection handler unavailable");
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const probe = {
      held: false,
      release,
      restore() {
        release();
        handlers.set(channel, original);
        delete globalThis.__boundaryConnection;
      },
    };
    handlers.set(channel, async (...args) => {
      const result = await original(...args);
      // IPC 将首装所需确认编码为 success=false；它不是完成事件，不能挡住真实安装入口。
      if (!(result as { success?: boolean } | undefined)?.success) return result;
      probe.held = true;
      await barrier;
      return result;
    });
    globalThis.__boundaryConnection = probe;
  }, PlatformChannels.ConnectRemote);
}

/** 只暂挂设置 RPC；不伪造连接、设置响应或确认结果。 */
export async function holdBoundarySetting(command: "get" | "update") {
  const signature = new BufferWriter();
  serialize(signature, ServiceChannels.Setting);
  serialize(signature, command);
  await browser.execute(
    (signature, command) => {
      const original = MessagePort.prototype.postMessage;
      const held: { port: MessagePort; data: Uint8Array }[] = [];
      let intercepting = true;
      const probe = {
        requests: [] as number[][],
        stop() {
          intercepting = false;
          return probe.requests;
        },
        async release(prefixes: number[][][]) {
          intercepting = false;
          await Promise.all(
            held.map(
              ({ port, data }, index) =>
                new Promise<void>((resolve) => {
                  const receive = (event: MessageEvent) => {
                    if (
                      !(event.data instanceof Uint8Array) ||
                      !prefixes[index]?.some((prefix) =>
                        prefix.every((byte, i) => event.data[i] === byte),
                      )
                    )
                      return;
                    port.removeEventListener("message", receive);
                    resolve();
                  };
                  port.addEventListener("message", receive);
                  original.call(port, data);
                }),
            ),
          );
          held.length = 0;
        },
        restore() {
          intercepting = false;
          MessagePort.prototype.postMessage = original;
          for (const { port, data } of held) original.call(port, data);
          held.length = 0;
          delete window.__boundarySetting;
        },
      };
      MessagePort.prototype.postMessage = function (message: unknown, options?: unknown) {
        if (intercepting && message instanceof Uint8Array) {
          const text = new TextDecoder().decode(message);
          if (
            message.some((_, start) =>
              signature.every((byte, offset) => message[start + offset] === byte),
            ) &&
            (command === "get" || text.includes("remoteBoundaryIntroAcknowledgedVersion"))
          ) {
            held.push({ port: this, data: message.slice() });
            probe.requests.push(Array.from(message));
            return;
          }
        }
        Reflect.apply(original, this, options === undefined ? [message] : [message, options]);
      };
      window.__boundarySetting = probe;
    },
    Array.from(signature.buffer.buffer),
    command,
  );
}

export async function releaseBoundarySetting(command: "get" | "update") {
  const requests = await browser.execute(() => window.__boundarySetting!.stop());
  expect(requests.length).toBeGreaterThan(0);
  const prefixes = requests.map((request) => {
    const reader = new BufferReader(VSBuffer.wrap(Uint8Array.from(request)));
    const header = deserialize(reader);
    expect(header).toEqual([100, expect.any(Number), ServiceChannels.Setting, command]);
    return [201, 202, 203].map((type) => {
      const writer = new BufferWriter();
      serialize(writer, [type, header[1]]);
      return Array.from(writer.buffer.buffer);
    });
  });
  await browser.execute((prefixes) => window.__boundarySetting!.release(prefixes), prefixes);
  await browser.executeAsync((done) =>
    requestAnimationFrame(() => requestAnimationFrame(() => done())),
  );
  await browser.execute(() => window.__boundarySetting?.restore());
}

export async function restoreBoundaryProbes() {
  await browser.execute(() => window.__boundarySetting?.restore());
  await browser.electron.execute(() => globalThis.__boundaryConnection?.restore());
}
