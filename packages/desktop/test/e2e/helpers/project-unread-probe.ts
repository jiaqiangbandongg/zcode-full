import { BufferReader, BufferWriter, deserialize, serialize, VSBuffer } from "@zcode/rpc";
import { ServiceChannels } from "@zcode/shared";

interface ProjectUnreadProbe {
  held: number[] | null;
  replied: boolean;
  reads: number;
  release(prefix: number[]): void;
  restore(): void;
}
declare global {
  interface Window {
    __projectUnreadProbe?: ProjectUnreadProbe;
  }
}

/** 只暂挂精确任务的首个未读命令；释放后仍由真实 Host/SQLite 写入并返回原始 marker。 */
export async function holdProjectUnread(taskId: string, workspaceIdentity: string) {
  await browser.execute(
    (channel, taskId, identity) => {
      const original = MessagePort.prototype.postMessage;
      let send: (() => void) | undefined;
      let port: MessagePort | undefined;
      let receive: ((event: MessageEvent) => void) | undefined;
      const probe: ProjectUnreadProbe = {
        held: null,
        replied: false,
        reads: 0,
        release(prefix) {
          if (!port || !send) throw new Error("Unread command not held");
          receive = (event) => {
            if (
              event.data instanceof Uint8Array &&
              prefix.every((byte, i) => event.data[i] === byte)
            ) {
              probe.replied = true;
              port?.removeEventListener("message", receive!);
            }
          };
          port.addEventListener("message", receive);
          send();
          send = undefined;
        },
        restore() {
          send?.();
          if (receive) port?.removeEventListener("message", receive);
          MessagePort.prototype.postMessage = original;
          delete window.__projectUnreadProbe;
        },
      };
      MessagePort.prototype.postMessage = function (message: unknown, options?: unknown) {
        const forward = () =>
          Reflect.apply(original, this, options === undefined ? [message] : [message, options]);
        const text = message instanceof Uint8Array ? new TextDecoder().decode(message) : "";
        if (
          text.includes(channel) &&
          text.includes("mutateTask") &&
          text.includes(taskId) &&
          text.includes(identity)
        ) {
          if (text.includes("mark-read")) probe.reads++;
          if (text.includes("mark-unread") && !probe.held && message instanceof Uint8Array) {
            probe.held = Array.from(message);
            // 复用实际发送该命令的端口，不增加另一条服务调用路径。
            // eslint-disable-next-line @typescript-eslint/no-this-alias
            port = this;
            send = forward;
            return;
          }
        }
        forward();
      };
      window.__projectUnreadProbe = probe;
    },
    ServiceChannels.WindowController,
    taskId,
    workspaceIdentity,
  );
}

export async function releaseProjectUnread() {
  const bytes = await browser.execute(() => window.__projectUnreadProbe?.held);
  if (!bytes) throw new Error("Unread command not held");
  const reader = new BufferReader(VSBuffer.wrap(Uint8Array.from(bytes)));
  const [, id] = deserialize(reader) as [number, number];
  const writer = new BufferWriter();
  serialize(writer, [201, id]);
  await browser.execute(
    (prefix) => window.__projectUnreadProbe!.release(prefix),
    Array.from(writer.buffer.buffer),
  );
  await browser.waitUntil(
    () => browser.execute(() => Boolean(window.__projectUnreadProbe?.replied)),
    {
      timeout: 30_000,
      timeoutMsg: "真实未读 mutation 未返回",
    },
  );
  expect(await browser.execute(() => window.__projectUnreadProbe?.reads)).toBe(0);
}

export async function restoreProjectUnreadProbe() {
  await browser.execute(() => window.__projectUnreadProbe?.restore());
}
