/**
 * 无用户手势的 sendFollowUpMessage 需要用户确认（可编辑 prompt）。
 * 与 confirmDialogStore 同构：请求排队、宿主组件订阅并渲染当前一条，resolve 返回最终文本或 null（取消）。
 */
export interface PluginUiFollowUpRequest {
  requestId: number;
  pluginId: string;
  prompt: string;
}

type Listener = () => void;

const listeners = new Set<Listener>();
const queue: Array<{ request: PluginUiFollowUpRequest; resolve: (value: string | null) => void }> =
  [];
let nextId = 1;

function notify() {
  for (const listener of listeners) listener();
}

export function requestPluginUiFollowUpConfirmation(input: {
  pluginId: string;
  prompt: string;
}): Promise<string | null> {
  return new Promise((resolve) => {
    queue.push({ request: { requestId: nextId++, ...input }, resolve });
    notify();
  });
}

export function getCurrentPluginUiFollowUpRequest(): PluginUiFollowUpRequest | null {
  return queue[0]?.request ?? null;
}

export function resolvePluginUiFollowUpRequest(requestId: number, value: string | null): void {
  const index = queue.findIndex((entry) => entry.request.requestId === requestId);
  if (index < 0) return;
  const [entry] = queue.splice(index, 1);
  entry?.resolve(value);
  notify();
}

export function subscribePluginUiFollowUpRequests(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
