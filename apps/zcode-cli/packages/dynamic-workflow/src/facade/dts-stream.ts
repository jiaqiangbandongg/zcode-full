/**
 * facade 的 stream 段（docs/dynamic-workflow/authoring.md「Streams」）：channel / future。
 *
 * 自成一个模块只因 dts.ts 顶在 max-lines 上限（模板字面量里的散文按代码行计）；契约不变：
 * 这一段仍由 dts.ts 拼进 `FACADE_DTS` 与 `SNIPPET_FACADE_DTS`，tests/facade-dts.test.ts 以
 * sha256 钉住拼接结果。段以单个换行开头结尾，与其余段同规。
 */

/**
 * 流水线原语：channel / future（docs/dynamic-workflow/authoring.md「Streams」）。两个 facade 都含
 * ——片段正是排练一段流水线逻辑的工作台。二者都是沙箱内的纯 promise 机制（与 Promise.all
 * 同席）：无站点、无 journal 行、不过线；lowering 只把调用改写成 `__host.channel` /
 * `__host.future`，实现全在 child-source.ts 的 cell 里。
 */
export const FACADE_STREAM_SEGMENT = String.raw`
/**
 * A stream of typed items between two stages: one stage send()s, another drains it with
 * for await. Unbounded, first-in-first-out, each item to exactly one receiver.
 */
declare interface Channel<T> extends AsyncIterable<T> {
  /** Enqueue one item; synchronous, never waits. Throws ChannelClosed after close(). */
  send(item: T): void;
  /**
   * End the stream: receivers get the remaining items, then their loops exit. Idempotent.
   * A channel nobody closes fails the run as ChannelDeadlock, naming it, once nothing in
   * flight could send to it again.
   */
  close(): void;
}

/**
 * Create a channel. The name labels the deadlock message; it is not an identity. A receiver
 * on an empty, open channel waits until a send or the close.
 */
declare function channel<T>(name?: string): Channel<T>;

/**
 * Run an async block as a concurrent stage. It starts immediately, not when awaited, and
 * returns its promise.
 */
declare function future<T>(body: () => Promise<T>): Promise<T>;
`;
