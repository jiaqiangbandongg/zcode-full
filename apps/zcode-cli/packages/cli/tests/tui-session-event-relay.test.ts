// TUI 常驻会话事件中继：换 app 时必须重挂（docs/dynamic-workflow/launch.md「The inline card」）。
//
// 这条性质的失效是安静的：/new、/resume、/fork 之后订阅还挂在旧 runtime 上，TUI 就再也收不到
// 出回合事件（dwf 进度、后台通知驱动的回合），而界面看起来完全正常。所以它必须有测试。
import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEvent } from "@zcode/contracts";
import { createTuiSessionEventRelay } from "../src/tui-session-event-relay.js";

/** 一个假 runtime：记录挂载/卸载次数，并能主动发事件。 */
function fakeRuntime(name: string) {
  const state = {
    name,
    attachCount: 0,
    detachCount: 0,
    emit: (_event: SessionEvent) => {},
    attached: false,
  };
  const subscribe = (sink: { onSessionEvent: (event: SessionEvent) => void }) => {
    state.attachCount += 1;
    state.attached = true;
    state.emit = (event) => sink.onSessionEvent(event);
    return () => {
      state.detachCount += 1;
      state.attached = false;
      state.emit = () => {};
    };
  };
  return { state, runtime: { subscribeEvents: subscribe } };
}

const readSubscriber = (runtime: unknown) => {
  const candidate = (runtime as { subscribeEvents?: unknown } | undefined)?.subscribeEvents;
  return typeof candidate === "function"
    ? (candidate as (sink: { onSessionEvent: (event: SessionEvent) => void }) => () => void)
    : undefined;
};

const event = (id: string) =>
  ({ id, type: "dynamic_workflow_run_progress" }) as unknown as SessionEvent;

test("the first sink attaches to the current runtime", () => {
  const first = fakeRuntime("first");
  const relay = createTuiSessionEventRelay({
    currentRuntime: () => first.runtime,
    readSubscriber,
  });

  assert.equal(relay.isAttached(), false);
  const received: string[] = [];
  relay.addSink((e) => received.push(e.id));

  assert.equal(relay.isAttached(), true);
  assert.equal(first.state.attachCount, 1);
  first.state.emit(event("e1"));
  assert.deepEqual(received, ["e1"]);
});

test("reattach after an app swap detaches the old runtime and follows the new one", () => {
  const first = fakeRuntime("first");
  const second = fakeRuntime("second");
  let current: unknown = first.runtime;
  const relay = createTuiSessionEventRelay({
    currentRuntime: () => current,
    readSubscriber,
  });

  const received: string[] = [];
  relay.addSink((e) => received.push(e.id));
  first.state.emit(event("before-swap"));

  // replaceApp 换 app 后调 reattach。
  current = second.runtime;
  relay.reattach();

  assert.equal(first.state.detachCount, 1, "old runtime must be detached");
  assert.equal(second.state.attachCount, 1, "new runtime must be attached");
  assert.equal(first.state.attached, false);

  // 新 runtime 的事件到得了；旧的已经断开，发不出东西。
  second.state.emit(event("after-swap"));
  first.state.emit(event("orphan"));
  assert.deepEqual(received, ["before-swap", "after-swap"]);
});

test("remains attached across two app swaps", () => {
  const first = fakeRuntime("first");
  const second = fakeRuntime("second");
  let current: unknown = first.runtime;
  const relay = createTuiSessionEventRelay({ currentRuntime: () => current, readSubscriber });

  const received: string[] = [];
  relay.addSink((e) => received.push(e.id));
  current = second.runtime;
  relay.reattach();
  current = fakeRuntime("third").runtime;
  relay.reattach();

  // 同一个 sink 跨两次换 app 仍然在册（TUI 侧不需要重挂 useEffect）。
  assert.equal(relay.isAttached(), true);
  assert.equal(received.length, 0);
});

test("reattach with no sinks stays detached (no subscription leak)", () => {
  const only = fakeRuntime("only");
  const relay = createTuiSessionEventRelay({ currentRuntime: () => only.runtime, readSubscriber });

  relay.reattach();
  assert.equal(relay.isAttached(), false);
  assert.equal(only.state.attachCount, 0);
});

test("the last sink unsubscribing detaches the runtime", () => {
  const only = fakeRuntime("only");
  const relay = createTuiSessionEventRelay({ currentRuntime: () => only.runtime, readSubscriber });

  const stopA = relay.addSink(() => {});
  const stopB = relay.addSink(() => {});
  stopA();
  assert.equal(relay.isAttached(), true, "one remaining sink keeps the subscription");
  stopB();
  assert.equal(relay.isAttached(), false);
  assert.equal(only.state.detachCount, 1);
});

test("a runtime with no subscribeEvents degrades to unattached rather than throwing", () => {
  const relay = createTuiSessionEventRelay({ currentRuntime: () => ({}), readSubscriber });
  const received: string[] = [];
  relay.addSink((e) => received.push(e.id));
  assert.equal(relay.isAttached(), false);
  // 能力缺席不该让 TUI 起不来。
  relay.reattach();
  assert.deepEqual(received, []);
});

test("a sink unsubscribing during fan-out does not break the dispatch", () => {
  const only = fakeRuntime("only");
  const relay = createTuiSessionEventRelay({ currentRuntime: () => only.runtime, readSubscriber });

  const seen: string[] = [];
  let stopSelf: (() => void) | undefined;
  stopSelf = relay.addSink((e) => {
    seen.push(`a:${e.id}`);
    stopSelf?.();
  });
  relay.addSink((e) => seen.push(`b:${e.id}`));

  only.state.emit(event("e1"));
  // 第一个 sink 在回调里退订，第二个仍然收到本条。
  assert.deepEqual(seen, ["a:e1", "b:e1"]);
  only.state.emit(event("e2"));
  assert.deepEqual(seen, ["a:e1", "b:e1", "b:e2"]);
});
