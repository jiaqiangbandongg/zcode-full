/** 一次 HTTP 请求的取消资源；调用方须在回调内完成正文读取。 */
export async function withWebRemoteControlHttpSignal<T>(
  signal: AbortSignal,
  request: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (signal.aborted) throw signal.reason ?? new DOMException("Request aborted", "AbortError");

  // 旧浏览器缺少 AbortSignal.any/timeout，会在 fetch 前抛错并持续重连。
  // 使用基础 AbortController 合并取消与期限，范围包含完整正文，不增加连接状态。
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(
    () => controller.abort(new DOMException("Request timed out", "TimeoutError")),
    15_000,
  );
  try {
    return await request(controller.signal);
  } catch (error) {
    // HTTP 状态可在正文结束前被拒绝；释放未读正文后才能撤销期限。
    controller.abort();
    throw error;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
  }
}
