import { describe, it, expect, vi } from "vitest";
import {
  toDisposable,
  DisposableStore,
  Emitter,
  Event,
  Relay,
  EventMultiplexer,
  CancellationTokenSource,
} from "../src/foundation.js";

describe("toDisposable", () => {
  it("should call the function on dispose", () => {
    const fn = vi.fn();
    const d = toDisposable(fn);
    d.dispose();
    expect(fn).toHaveBeenCalledOnce();
  });

  it("should only call the function once", () => {
    const fn = vi.fn();
    const d = toDisposable(fn);
    d.dispose();
    d.dispose();
    expect(fn).toHaveBeenCalledOnce();
  });
});

describe("DisposableStore", () => {
  it("should dispose all items", () => {
    const store = new DisposableStore();
    const fn1 = vi.fn();
    const fn2 = vi.fn();
    store.add(toDisposable(fn1));
    store.add(toDisposable(fn2));
    store.dispose();
    expect(fn1).toHaveBeenCalledOnce();
    expect(fn2).toHaveBeenCalledOnce();
  });

  it("should dispose items added after dispose immediately", () => {
    const store = new DisposableStore();
    store.dispose();
    const fn = vi.fn();
    store.add(toDisposable(fn));
    expect(fn).toHaveBeenCalledOnce();
  });

  it("should not double-dispose", () => {
    const store = new DisposableStore();
    const fn = vi.fn();
    store.add(toDisposable(fn));
    store.dispose();
    store.dispose();
    expect(fn).toHaveBeenCalledOnce();
  });
});

describe("Emitter", () => {
  it("should fire events to listeners", () => {
    const emitter = new Emitter<number>();
    const values: number[] = [];
    emitter.event((v) => values.push(v));
    emitter.fire(1);
    emitter.fire(2);
    expect(values).toEqual([1, 2]);
  });

  it("should support multiple listeners", () => {
    const emitter = new Emitter<string>();
    const a: string[] = [];
    const b: string[] = [];
    emitter.event((v) => a.push(v));
    emitter.event((v) => b.push(v));
    emitter.fire("hello");
    expect(a).toEqual(["hello"]);
    expect(b).toEqual(["hello"]);
  });

  it("should allow unsubscribing via dispose", () => {
    const emitter = new Emitter<number>();
    const values: number[] = [];
    const d = emitter.event((v) => values.push(v));
    emitter.fire(1);
    d.dispose();
    emitter.fire(2);
    expect(values).toEqual([1]);
  });

  it("should not fire after dispose", () => {
    const emitter = new Emitter<number>();
    const values: number[] = [];
    emitter.event((v) => values.push(v));
    emitter.dispose();
    emitter.fire(1);
    expect(values).toEqual([]);
  });

  it("should call onWillAddFirstListener and onDidRemoveLastListener", () => {
    const onFirst = vi.fn();
    const onLast = vi.fn();
    const emitter = new Emitter<void>({
      onWillAddFirstListener: onFirst,
      onDidRemoveLastListener: onLast,
    });

    const d1 = emitter.event(() => {});
    expect(onFirst).toHaveBeenCalledOnce();
    expect(onLast).not.toHaveBeenCalled();

    const d2 = emitter.event(() => {});
    expect(onFirst).toHaveBeenCalledOnce(); // not called again

    d1.dispose();
    expect(onLast).not.toHaveBeenCalled(); // still has d2

    d2.dispose();
    expect(onLast).toHaveBeenCalledOnce();
  });
});

describe("Event", () => {
  it("Event.once should only fire once", () => {
    const emitter = new Emitter<number>();
    const values: number[] = [];
    Event.once(emitter.event)((v) => values.push(v));
    emitter.fire(1);
    emitter.fire(2);
    expect(values).toEqual([1]);
  });

  it("Event.toPromise should resolve on first fire", async () => {
    const emitter = new Emitter<string>();
    const promise = Event.toPromise(emitter.event);
    emitter.fire("done");
    expect(await promise).toBe("done");
  });

  it("Event.filter should only pass matching events", () => {
    const emitter = new Emitter<number>();
    const values: number[] = [];
    Event.filter(emitter.event, (n) => n > 2)((v) => values.push(v));
    emitter.fire(1);
    emitter.fire(3);
    emitter.fire(2);
    emitter.fire(5);
    expect(values).toEqual([3, 5]);
  });

  it("Event.map should transform events", () => {
    const emitter = new Emitter<number>();
    const values: string[] = [];
    Event.map(emitter.event, (n) => `val:${n}`)((v) => values.push(v));
    emitter.fire(1);
    emitter.fire(2);
    expect(values).toEqual(["val:1", "val:2"]);
  });
});

describe("Relay", () => {
  it("should relay events from input source", () => {
    const source = new Emitter<number>();
    const relay = new Relay<number>();
    relay.input = source.event;

    const values: number[] = [];
    relay.event((v) => values.push(v));
    source.fire(1);
    source.fire(2);
    expect(values).toEqual([1, 2]);
  });

  it("should switch input source", () => {
    const source1 = new Emitter<number>();
    const source2 = new Emitter<number>();
    const relay = new Relay<number>();

    const values: number[] = [];
    relay.event((v) => values.push(v));

    relay.input = source1.event;
    source1.fire(1);

    relay.input = source2.event;
    source1.fire(2); // should be ignored
    source2.fire(3);

    expect(values).toEqual([1, 3]);
  });
});

describe("EventMultiplexer", () => {
  it("should aggregate multiple event sources", () => {
    const e1 = new Emitter<string>();
    const e2 = new Emitter<string>();
    const mux = new EventMultiplexer<string>();
    mux.add(e1.event);
    mux.add(e2.event);

    const values: string[] = [];
    mux.event((v) => values.push(v));
    e1.fire("a");
    e2.fire("b");
    expect(values).toEqual(["a", "b"]);
  });
});

describe("CancellationTokenSource", () => {
  it("should fire cancellation event on cancel", () => {
    const cts = new CancellationTokenSource();
    const fn = vi.fn();
    cts.token.onCancellationRequested(fn);
    expect(cts.token.isCancellationRequested).toBe(false);
    cts.cancel();
    expect(fn).toHaveBeenCalledOnce();
  });

  it("should only fire once", () => {
    const cts = new CancellationTokenSource();
    const fn = vi.fn();
    cts.token.onCancellationRequested(fn);
    cts.cancel();
    cts.cancel();
    expect(fn).toHaveBeenCalledOnce();
  });
});
