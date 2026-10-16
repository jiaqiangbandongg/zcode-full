import { expect, it, vi } from "vitest";
import { NetworkCaptureBuffer } from "../../src/main/networkCaptureBuffer.js";
import { subscribeBeforeRequest } from "../../src/main/observeBeforeRequest.js";
import type { WebRequest, OnBeforeRequestListenerDetails } from "electron";

it("缓存有界，旧 capture 批次被拒绝，清空不停止采集，关闭释放数据", () => {
  const buffer = new NetworkCaptureBuffer();
  const record = {
    timestamp: 1,
    processType: "host" as const,
    pid: 42,
    method: "GET",
    url: "https://example.test/path?token=secret",
  };
  buffer.start("one");
  for (let i = 0; i < 12; i++)
    buffer.ingest({ captureId: "one", records: Array(100).fill(record), dropped: 0 });
  expect(buffer.snapshot().records).toHaveLength(1_000);
  expect(buffer.snapshot().dropped).toBe(200);
  expect(JSON.stringify(buffer.snapshot())).not.toContain("secret");
  buffer.start("two");
  buffer.ingest({ captureId: "one", records: [record], dropped: 0 });
  expect(buffer.snapshot().records).toHaveLength(0);
  buffer.ingest({ captureId: "two", records: [record], dropped: 0 });
  buffer.clear();
  expect(buffer.snapshot()).toMatchObject({ captureId: "two", records: [], dropped: 0 });
  buffer.stop();
  expect(() => buffer.snapshot()).toThrow();
});

it("Electron 单 listener 分发不会覆盖其他观测者，异常仍原样放行，停用恢复过滤器", () => {
  let listener:
    | ((details: OnBeforeRequestListenerDetails, callback: (response: object) => void) => void)
    | null;
  const onBeforeRequest = vi.fn((_filter, next) => {
    listener = next;
  });
  const webRequest = { onBeforeRequest } as unknown as WebRequest;
  const cdnObserver = vi.fn();
  const removeCdnObserver = subscribeBeforeRequest(
    webRequest,
    ["https://*.alicdn.com/*"],
    cdnObserver,
  );
  const removeCapture = subscribeBeforeRequest(webRequest, ["http://*/*", "https://*/*"], () => {
    throw new Error("closed");
  });
  const callback = vi.fn();
  listener!({ url: "https://g.alicdn.com/a" } as OnBeforeRequestListenerDetails, callback);
  expect(callback).toHaveBeenCalledExactlyOnceWith({});
  expect(cdnObserver).toHaveBeenCalledOnce();
  removeCapture();
  expect(onBeforeRequest.mock.lastCall![0]).toEqual({ urls: ["https://*.alicdn.com/*"] });
  removeCdnObserver();
  expect(onBeforeRequest.mock.lastCall![0]).toBeNull();
});
