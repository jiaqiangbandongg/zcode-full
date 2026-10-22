import { BufferReader, BufferWriter, deserialize, serialize, VSBuffer } from "@zcode/rpc";
import { ISourceServerManagementService } from "@zcode/services";

interface SnapshotFault {
  requests: number[][];
  updateCalls: number;
  reject(index: number, response: number[]): void;
  resume(): void;
  restore(): void;
}

declare global {
  interface Window {
    __sourceSnapshotFault?: SnapshotFault;
  }
}

/** 向导打开期间暂挂无参数快照读取；订阅初始化和真实 SSH/更新请求保持原样。 */
export async function holdWizardSourceSnapshot(): Promise<void> {
  await browser.execute((channelName) => {
    const original = MessagePort.prototype.postMessage;
    const held = new Map<number, { port: MessagePort; data: Uint8Array }>();
    let intercepting = true;
    const fault: SnapshotFault = {
      requests: [],
      updateCalls: 0,
      reject(index, response) {
        const request = held.get(index);
        if (!request) throw new Error("Missing held Source snapshot request");
        held.delete(index);
        request.port.dispatchEvent(
          new MessageEvent("message", { data: Uint8Array.from(response) }),
        );
      },
      resume() {
        intercepting = false;
        for (const request of held.values()) original.call(request.port, request.data);
        held.clear();
      },
      restore() {
        MessagePort.prototype.postMessage = original;
        fault.resume();
        delete window.__sourceSnapshotFault;
      },
    };
    MessagePort.prototype.postMessage = function (message: unknown, options?: unknown) {
      if (message instanceof Uint8Array) {
        const text = new TextDecoder().decode(message);
        if (text.includes(channelName)) {
          if (text.includes("updateSource")) fault.updateCalls += 1;
          if (
            intercepting &&
            text.includes("getSnapshot") &&
            !text.includes("refreshMigrationCounts") &&
            document.querySelector('[data-testid="ssh-dialog"]')
          ) {
            held.set(fault.requests.length, { port: this, data: message.slice() });
            fault.requests.push(Array.from(message));
            return;
          }
        }
      }
      Reflect.apply(original, this, options === undefined ? [message] : [message, options]);
    };
    window.__sourceSnapshotFault = fault;
  }, ISourceServerManagementService.channelName);
}

export async function rejectWizardSourceSnapshot(message: string): Promise<number> {
  let rejected = 0;
  // 多个后台消费者会同时读同一服务；只拒绝第一条可能命中后台投影而漏过向导。
  // 将这一短暂读取故障持续到向导确认失败，再恢复服务，避免用调用次数猜测归属。
  await browser.waitUntil(
    async () => {
      const requests = await browser.execute(() => window.__sourceSnapshotFault!.requests);
      while (rejected < requests.length) {
        const reader = new BufferReader(VSBuffer.wrap(Uint8Array.from(requests[rejected]!)));
        const header = deserialize(reader);
        expect(header).toEqual([
          100,
          expect.any(Number),
          ISourceServerManagementService.channelName,
          "getSnapshot",
        ]);
        expect(deserialize(reader)).toEqual([]);
        const writer = new BufferWriter();
        // Channel RPC 的 PromiseError 响应；复用正式序列化器，不让故障变成无响应超时。
        serialize(writer, [202, header[1]]);
        serialize(writer, { name: "Error", message });
        await browser.execute(
          (index, response) => window.__sourceSnapshotFault!.reject(index, response),
          rejected++,
          Array.from(writer.buffer.buffer),
        );
      }
      return browser.execute((expected) => {
        const error = document.querySelector('[data-testid="ssh-error"]');
        return error?.querySelector("pre")?.textContent === expected;
      }, message);
    },
    { timeout: 30_000, timeoutMsg: "快照读取故障没有进入向导失败状态" },
  );
  await browser.execute(() => window.__sourceSnapshotFault!.resume());
  return rejected;
}

export function readSnapshotFaultUpdateCalls(): Promise<number> {
  return browser.execute(() => window.__sourceSnapshotFault?.updateCalls ?? 0);
}

export async function restoreSnapshotFault(): Promise<void> {
  await browser.execute(() => window.__sourceSnapshotFault?.restore());
}
