import { Emitter } from "@zcode/rpc";
import { expect, it, vi } from "vitest";
import { LocalRuntimeNetworkCapture } from "../src/zcode-agent/localRuntimeNetworkCapture.js";
import type { ZCodeProtocolClient } from "../src/zcode-agent/zcodeProtocolClient.js";
import type { ZCodeProtocolNotification } from "@zcode/shared";

it("已有和新本地 CLI 继承启停，旧批次隔离，不注册的 remote 不控制", () => {
  const registry = new LocalRuntimeNetworkCapture();
  const makeClient = () => {
    const events = new Emitter<ZCodeProtocolNotification>();
    const notify = vi.fn(async () => {});
    return {
      events,
      notify,
      client: {
        onNotification: events.event,
        notify,
        isDisposed: false,
      } as unknown as ZCodeProtocolClient,
    };
  };
  const a = makeClient(),
    b = makeClient(),
    remote = makeClient();
  const remove = registry.register(a.client, 41);
  expect(a.notify).not.toHaveBeenCalled();
  const sink = vi.fn();
  registry.setCaptureId("one", sink);
  registry.register(b.client, 42);
  expect(a.notify).toHaveBeenCalledWith("process/networkCapture", { captureId: "one" });
  expect(b.notify).toHaveBeenCalledWith("process/networkCapture", { captureId: "one" });
  expect(remote.notify).not.toHaveBeenCalled();
  const batch = {
    captureId: "one",
    dropped: 0,
    records: [
      { timestamp: 1, pid: 999, processType: "main", method: "GET", url: "https://example.test/" },
    ],
  };
  a.events.fire({ method: "process/networkRequests", params: batch });
  expect(sink.mock.lastCall![0].records[0]).toMatchObject({ pid: 41, processType: "cli" });
  registry.setCaptureId(null);
  expect(a.notify).toHaveBeenLastCalledWith("process/networkCapture", { captureId: null });
  registry.setCaptureId("two", sink);
  a.events.fire({ method: "process/networkRequests", params: batch });
  expect(sink).toHaveBeenCalledTimes(1);
  remove();
  a.events.fire({ method: "process/networkRequests", params: { ...batch, captureId: "two" } });
  expect(sink).toHaveBeenCalledTimes(1);
  registry.setCaptureId(null);
});
