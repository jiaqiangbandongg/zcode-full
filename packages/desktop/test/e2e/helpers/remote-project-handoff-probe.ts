import { BufferReader, BufferWriter, deserialize, serialize, VSBuffer } from "@zcode/rpc";
import { PlatformChannels, ServiceChannels } from "@zcode/shared";
import type { RemoteProjectDirectory } from "@zcode/services";

interface HandoffRpcProbe {
  ready: boolean;
  call(request: number[], prefixes: number[][]): Promise<number[]>;
  restore(): void;
}
declare global {
  interface Window {
    __remoteProjectHandoffRpc?: HandoffRpcProbe;
  }
}
let requestId = -9400;

/** 复用当前 Window Host 的 RPC 端口；并发移除模拟手机命令，不直接改 SQLite。 */
export async function installHandoffRpcProbe() {
  await browser.execute((channel) => {
    const original = MessagePort.prototype.postMessage;
    let port: MessagePort | undefined;
    const probe: HandoffRpcProbe = {
      ready: false,
      call(request, prefixes) {
        if (!port) throw new Error("Window Host port unavailable");
        const target = port;
        return new Promise((resolve) => {
          const receive = (event: MessageEvent) => {
            if (!(event.data instanceof Uint8Array)) return;
            if (
              !prefixes.some((prefix) => prefix.every((byte, index) => event.data[index] === byte))
            )
              return;
            target.removeEventListener("message", receive);
            resolve(Array.from(event.data));
          };
          target.addEventListener("message", receive);
          original.call(target, Uint8Array.from(request));
        });
      },
      restore() {
        MessagePort.prototype.postMessage = original;
        delete window.__remoteProjectHandoffRpc;
      },
    };
    MessagePort.prototype.postMessage = function (message: unknown, options?: unknown) {
      if (message instanceof Uint8Array && new TextDecoder().decode(message).includes(channel)) {
        // RPC 端口由平台回调的 this 提供，受控命令必须复用同一端口。
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        port = this;
        probe.ready = true;
      }
      Reflect.apply(original, this, options === undefined ? [message] : [message, options]);
    };
    window.__remoteProjectHandoffRpc = probe;
    window.dispatchEvent(new Event("focus"));
  }, ServiceChannels.RemoteProjects);
  await browser.waitUntil(
    () => browser.execute(() => Boolean(window.__remoteProjectHandoffRpc?.ready)),
    {
      timeout: 30_000,
      timeoutMsg: "未捕获 Window Host 项目端口",
    },
  );
}
export async function callHandoffHost<T>(
  channel: string,
  command: string,
  args: unknown[] = [],
): Promise<T> {
  const id = requestId--;
  const writer = new BufferWriter();
  serialize(writer, [100, id, channel, command]);
  serialize(writer, args);
  const prefixes = [201, 202, 203].map((type) => {
    const prefix = new BufferWriter();
    serialize(prefix, [type, id]);
    return Array.from(prefix.buffer.buffer);
  });
  const response = await browser.execute(
    (request, prefixes) => window.__remoteProjectHandoffRpc!.call(request, prefixes),
    Array.from(writer.buffer.buffer),
    prefixes,
  );
  const reader = new BufferReader(VSBuffer.wrap(Uint8Array.from(response)));
  const header = deserialize(reader) as [number, number];
  const body = deserialize(reader);
  if (header[0] !== 201) throw new Error(typeof body === "string" ? body : body.message);
  return body as T;
}

/**
 * 在线远程项目菜单与本地项目一致，不再提供「从本机移除」；用例按项目行身份直接调用本机入口服务，
 * 语义仍是只移除本机入口与缓存，不改远端项目与会话。
 */
export async function removeRemoteProjectEntryForRow(sectionSelector: string): Promise<void> {
  if (!(await browser.execute(() => Boolean(window.__remoteProjectHandoffRpc?.ready))))
    await installHandoffRpcProbe();
  const row = await browser.execute((selector) => {
    const element = document.querySelector<HTMLElement>(selector);
    return { projectId: element?.dataset.projectId, hostId: element?.dataset.projectHost };
  }, sectionSelector);
  const directory = await callHandoffHost<RemoteProjectDirectory>(
    ServiceChannels.RemoteProjects,
    "readDirectory",
  );
  const entry = directory.entries.find(
    (candidate) => candidate.projectId === row.projectId && candidate.hostId === row.hostId,
  );
  if (!entry) throw new Error(`${sectionSelector} 没有对应的本机远程项目入口`);
  await callHandoffHost(ServiceChannels.RemoteProjects, "removeEntry", [entry.id]);
}

type BindHandler = (...args: unknown[]) => Promise<unknown>;
interface BindProbe {
  held: boolean;
  release(): void;
  restore(): void;
}
declare global {
  var __remoteProjectBindProbe: BindProbe | undefined;
}
/** 暂挂真实 Host bind 的返回值，保证移除发生在 Root 初检之后、导航提交之前。 */
export async function holdProjectBind(workspacePath: string) {
  await browser.electron.execute(
    (electron, channel, path) => {
      const handlers = (
        electron.ipcMain as unknown as { _invokeHandlers: Map<string, BindHandler> }
      )._invokeHandlers;
      const original = handlers.get(channel);
      if (!original) throw new Error("Bind handler unavailable");
      let resume!: () => void;
      const barrier = new Promise<void>((resolve) => {
        resume = resolve;
      });
      const probe: BindProbe = {
        held: false,
        release: resume,
        restore() {
          resume();
          handlers.set(channel, original);
          delete globalThis.__remoteProjectBindProbe;
        },
      };
      handlers.set(channel, async (...args) => {
        const result = await original(...args);
        if ((args[1] as { workspacePath?: string })?.workspacePath === path && !probe.held) {
          probe.held = true;
          await barrier;
        }
        return result;
      });
      globalThis.__remoteProjectBindProbe = probe;
    },
    PlatformChannels.BindRemoteWorkspaceSessionContext,
    workspacePath,
  );
}
export async function waitForHeldProjectBind() {
  await browser.waitUntil(
    () => browser.electron.execute(() => Boolean(globalThis.__remoteProjectBindProbe?.held)),
    {
      timeout: 120_000,
      timeoutMsg: "真实项目 bind 未到达完成屏障",
    },
  );
}
export async function releaseProjectBind() {
  await browser.electron.execute(() => globalThis.__remoteProjectBindProbe?.release());
}
export async function restoreHandoffProbes() {
  await browser.electron.execute(() => globalThis.__remoteProjectBindProbe?.restore());
  await browser.execute(() => window.__remoteProjectHandoffRpc?.restore());
}
