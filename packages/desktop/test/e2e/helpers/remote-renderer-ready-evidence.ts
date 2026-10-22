/** 只认 Main 校验 attachment 后写出的 reload ready ACK，忽略连接事件、迟到拒绝和半行日志。 */
export function countRendererReloadAcks(content: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of content.split("\n").slice(0, -1)) {
    const match =
      /^\[[^\]]+\] \[info\] \[pid:\d+\] \[main\] \[window-host-remote\] renderer attachment ready, sessionId=([^,\s]+), reason=[^,\s]+:renderer-reload\r?$/u.exec(
        line,
      );
    if (match) counts.set(match[1]!, (counts.get(match[1]!) ?? 0) + 1);
  }
  return counts;
}
