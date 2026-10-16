/**
 * cell 的第二段引导脚本：流水线原语 channel / future 与停滞检测
 * （docs/dynamic-workflow/authoring.md「Streams」、execution-engine.md「The vm cell」）。
 *
 * 为什么独立成模块：child-source.ts 的 childMain 受自包含约束（`toString()` 内嵌进入口文件，
 * 不得引用模块作用域绑定），所以这段文本不能作为它的模块级常量；留在 BOOTSTRAP 里又会顶穿单文件
 * 行数上限。于是 {@link renderChildEntry} 把它像 payload 一样以字面量内嵌进入口文件，`start`
 * 经 deps 递给 childMain，childMain 在 BOOTSTRAP 之后于**同一个 context** 内运行它。
 *
 * 契约（与 BOOTSTRAP 的接缝）：只依赖 BOOTSTRAP 用 `var`/function 建下的四个 context 全局——
 * `__pending`（在飞请求表）、`__settled`（是否已发 complete）、`__complete(ok, payload)`、
 * `globalThis.__host`；产出三样——`__host.channel`、`__host.future`、`globalThis.__checkStalled`。
 * 纯 JS、无 backtick / ${}（以便安全内嵌），与 BOOTSTRAP 同规。
 *
 * 确定性：channel 的每次投递都是 host 结算顺序（引擎回放它）的确定性后果，所以不落 journal、
 * 不过线。性能：两条队列都以「数组 + 头下标」读，send / next 均 O(1)，消耗掉的前缀长过活着的
 * 部分时压缩一次。
 */
export const CELL_STREAMS_BOOTSTRAP = String.raw`
"use strict";

// —— 流水线原语：channel / future ——
var __channels = [];
var __parkedReceivers = 0;
var __CHANNEL_COMPACT_MIN = 1024;
var __END = Object.freeze({ value: undefined, done: true });

function __channel(name) {
  var label = name === undefined || name === null ? "channel #" + (__channels.length + 1) : String(name);
  var state = { label: label, items: [], head: 0, waiters: [], waitHead: 0, closed: false };
  __channels.push(state);

  function compact() {
    if (state.head >= __CHANNEL_COMPACT_MIN && state.head * 2 >= state.items.length) {
      state.items = state.items.slice(state.head);
      state.head = 0;
    }
    if (state.waitHead >= __CHANNEL_COMPACT_MIN && state.waitHead * 2 >= state.waiters.length) {
      state.waiters = state.waiters.slice(state.waitHead);
      state.waitHead = 0;
    }
  }
  function takeWaiter() {
    if (state.waitHead >= state.waiters.length) return undefined;
    var waiter = state.waiters[state.waitHead];
    state.waiters[state.waitHead] = undefined;
    state.waitHead += 1;
    __parkedReceivers -= 1;
    compact();
    return waiter;
  }
  function next() {
    if (state.head < state.items.length) {
      var item = state.items[state.head];
      state.items[state.head] = undefined;
      state.head += 1;
      compact();
      return Promise.resolve({ value: item, done: false });
    }
    if (state.closed) return Promise.resolve(__END);
    return new Promise(function (resolve) {
      state.waiters.push(resolve);
      __parkedReceivers += 1;
    });
  }
  var channel = {
    send: function (item) {
      if (state.closed) {
        var err = new Error("Channel \"" + state.label + "\" is closed: send() after close(). The stage that produces into a channel owns its close; close it in a finally once every producer has finished.");
        err.name = "ChannelClosed";
        err.code = "ChannelClosed";
        throw err;
      }
      var waiter = takeWaiter();
      if (waiter !== undefined) waiter({ value: item, done: false });
      else state.items.push(item);
    },
    close: function () {
      if (state.closed) return;
      state.closed = true;
      for (var waiter = takeWaiter(); waiter !== undefined; waiter = takeWaiter()) waiter(__END);
    },
  };
  channel[Symbol.asyncIterator] = function () {
    var iterator = {
      next: next,
      return: function () {
        return Promise.resolve(__END);
      },
    };
    iterator[Symbol.asyncIterator] = function () {
      return iterator;
    };
    return iterator;
  };
  return channel;
}

function __future(body) {
  // 立即调用、原样返回其 promise：future 是 async IIFE 的命名形态。同步抛出转成拒绝，
  // 让「一个 stage 的失败」永远走 join 那一条路，而不是从 future() 的调用点同步逃出。
  try {
    var result = body();
    return result instanceof Promise ? result : Promise.resolve(result);
  } catch (e) {
    return Promise.reject(e);
  }
}

// —— 停滞检测（execution-engine.md「The vm cell」）——
// cell 没有定时器、没有 I/O：能唤醒挂起脚本的只有 host response。于是「没有在飞请求、微任务
// 已排空、脚本未完成」就是「永远不会再有任何事发生」。外层 realm 在每条 response 投递之后与
// __execute 起步之后各调一次（setImmediate，在微任务之后），命中即以 error-complete 结束 run，
// 而不是让 run 永远挂着。有接收者停在 channel 上时报 ChannelDeadlock 并点名通道；否则报
// ScriptStalled（一个永不兑现的 promise）。
globalThis.__checkStalled = function () {
  if (__settled || __pending.size > 0) return false;
  var waiting = [];
  for (var i = 0; i < __channels.length; i++) {
    var ch = __channels[i];
    var count = ch.waiters.length - ch.waitHead;
    if (count > 0) waiting.push(count + " on \"" + ch.label + "\"");
  }
  var err;
  if (waiting.length > 0) {
    err = new Error(
      "Deadlock: " + __parkedReceivers + " receiver(s) waiting (" + waiting.join(", ") +
        ") with no request in flight, so nothing can ever send again. Close each channel from the stage that produces into it (ch.close() in a finally) once its producers are done."
    );
    err.name = "ChannelDeadlock";
    err.code = "ChannelDeadlock";
  } else {
    err = new Error(
      "Stalled: the script is suspended with no request in flight and no channel receiver waiting, so nothing can ever resolve what it awaits (a promise that is never settled)."
    );
    err.name = "ScriptStalled";
    err.code = "ScriptStalled";
  }
  __complete(false, err);
  return true;
};

globalThis.__host.channel = __channel;
globalThis.__host.future = __future;
`;
