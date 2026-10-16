export interface ParentDisconnectSource {
  once(event: "disconnect", listener: () => void): unknown;
  off(event: "disconnect", listener: () => void): unknown;
}

/**
 * 注册 Core 对 Supervisor IPC 断连的清理钩子。
 *
 * Supervisor 被强杀时不会再发送 shutdown command，Core 仍需主动收口自己的
 * HTTP/WebSocket 和 Agent 资源，否则它会绕过 data-root lock 成为孤儿进程。
 */
export function installParentDisconnectHandler(
  onDisconnect: () => void | Promise<void>,
  source: ParentDisconnectSource = process,
): () => void {
  const handler = (): void => {
    void onDisconnect();
  };
  source.once("disconnect", handler);
  return () => source.off("disconnect", handler);
}
