import { EmptyResultSchema } from "@modelcontextprotocol/core";
import { App } from "@modelcontextprotocol/ext-apps";
import { useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
const app = new App({ name: "host-fixture", version: "1.0.0" }, { tools: {} });
const samplingCalls = new Map<string, AbortController>();
(window as any).sample = async (key: string, params: any) => {
  const cancel = new AbortController();
  samplingCalls.set(key, cancel);
  try {
    return { result: await app.createSamplingMessage(params, { signal: cancel.signal }) };
  } catch (error) {
    return { error: String(error) };
  } finally {
    samplingCalls.delete(key);
  }
};
(window as any).cancelSample = (key: string) => samplingCalls.get(key)?.abort();
(window as any).samplingCapabilities = () => app.getHostCapabilities();
const resourceEvents: string[] = [];
const resourceWaiters = new Map<number, () => void>();
app.setNotificationHandler("notifications/resources/updated", (notification) => {
  resourceEvents.push(notification.params.uri);
  resourceWaiters.get(resourceEvents.length)?.();
  resourceWaiters.delete(resourceEvents.length);
});
(window as any).subscribeFixture = () =>
  app.request(
    { method: "resources/subscribe", params: { uri: "fixture://state" } },
    EmptyResultSchema,
  );
(window as any).waitResources = (count: number) =>
  resourceEvents.length >= count
    ? Promise.resolve()
    : new Promise<void>((resolve) => resourceWaiters.set(count, resolve));
(window as any).resourceEvents = resourceEvents;
(window as any).readResourceFixture = async (uri: string) => {
  try {
    return { result: await app.readServerResource({ uri }) };
  } catch (error) {
    return { error: String(error) };
  }
};
const pageCalls: { key: string; aborted: boolean }[] = [];
const abortWaiters = new Map<string, () => void>();
(window as any).waitPageAbort = (key: string) =>
  pageCalls.some((c) => c.key === key && c.aborted)
    ? Promise.resolve()
    : new Promise<void>((resolve) => abortWaiters.set(key, resolve));
const pageWaiters = new Map<string, () => void>();
(window as any).waitPageCall = (key: string) =>
  pageCalls.some((c) => c.key === key)
    ? Promise.resolve()
    : new Promise<void>((resolve) => pageWaiters.set(key, resolve));
const pageReleases = new Map<string, () => void>();
(window as any).pageCalls = pageCalls;
(window as any).releasePageCall = (key: string) => pageReleases.get(key)?.();
app.onlisttools = async () => ({
  tools: [
    {
      name: "page_edit",
      description: "Fixture page tool",
      inputSchema: {
        type: "object",
        properties: { key: { type: "string" }, delayed: { type: "boolean" } },
        required: ["key"],
      },
      annotations: { readOnlyHint: false },
    },
  ],
});
app.oncalltool = async (params, extra) => {
  const key = String(params.arguments?.key);
  const call = { key, aborted: false };
  pageCalls.push(call);
  pageWaiters.get(key)?.();
  pageWaiters.delete(key);
  if (params.arguments?.delayed)
    await new Promise<void>((resolve, reject) => {
      pageReleases.set(key, resolve);
      extra.mcpReq.signal.addEventListener(
        "abort",
        () => {
          call.aborted = true;
          abortWaiters.get(key)?.();
          abortWaiters.delete(key);
          reject(new Error("page aborted"));
        },
        { once: true },
      );
    });
  pageReleases.delete(key);
  return { content: [{ type: "text", text: `page:${key}` }], structuredContent: { key } };
};
const receivedFeed = { input: [] as number[], result: [] as number[] };
const feedWaiters = new Map<number, () => void>();
(window as any).receivedFeed = receivedFeed;
(window as any).waitFeed = (n: number) =>
  receivedFeed.result.includes(n)
    ? Promise.resolve()
    : new Promise<void>((resolve) => feedWaiters.set(n, resolve));
app.ontoolinput = (input) => {
  receivedFeed.input.push(input.arguments!.sequence as number);
};
app.ontoolresult = (result) => {
  const n = result.structuredContent!.sequence as number;
  receivedFeed.result.push(n);
  feedWaiters.get(n)?.();
  feedWaiters.delete(n);
};
const calls = new Map<string, AbortController>();
(window as any).callTool = async (key: string, delayed = false) => {
  const abort = new AbortController();
  calls.set(key, abort);
  try {
    return {
      result: await app.callServerTool(
        { name: "edit", arguments: { key, delayed } },
        { signal: abort.signal },
      ),
    };
  } catch (error) {
    return { error: String(error) };
  } finally {
    calls.delete(key);
  }
};
(window as any).cancelTool = (key: string) => calls.get(key)?.abort();
let ready!: () => void;
(window as any).fixtureReady = new Promise<void>((resolve) => {
  ready = resolve;
});
(window as any).starts = ((window as any).starts ?? 0) + 1;
function Counter() {
  const [count, setCount] = useState(0);
  const [text, setText] = useState("");
  useLayoutEffect(() => {
    ready();
  }, []);
  return (
    <>
      <button id="counter" onClick={() => setCount((n) => n + 1)}>
        {count}
      </button>
      <input id="input" value={text} onChange={(event) => setText(event.target.value)} />
      <div id="scroll" style={{ height: 80, overflow: "scroll" }}>
        <div style={{ height: 1000 }}>scroll fixture</div>
      </div>
    </>
  );
}
app.connect().then(() => createRoot(document.getElementById("root")!).render(<Counter />));
(window as any).storageRoundTrip = async (write: boolean) => {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("host-fixture");
    request.onupgradeneeded = () => request.result.createObjectStore("values");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  if (write) {
    localStorage.setItem("counter", "42");
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("values", "readwrite");
      tx.objectStore("values").put(42, "counter");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
  const value = await new Promise((resolve, reject) => {
    const request = db.transaction("values").objectStore("values").get("counter");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return { local: localStorage.getItem("counter"), indexed: value ?? null };
};

(window as any).saveWidget = (widgetState: unknown) =>
  app.request({ method: "ui/set-widget-state", params: { widgetState } }, EmptyResultSchema);
(window as any).readWidget = () => app.getHostContext()?.["zcode/widgetState"] ?? null;
(window as any).startStorageWriter = () =>
  new Promise<void>((resolve, reject) => {
    const request = indexedDB.open("host-fixture");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const write = () => {
        localStorage.setItem("counter", "racing");
        const tx = db.transaction("values", "readwrite");
        tx.objectStore("values").put("racing", "counter");
        tx.oncomplete = () => {
          resolve();
          write();
        };
        tx.onerror = () => reject(tx.error);
      };
      write();
    };
  });
