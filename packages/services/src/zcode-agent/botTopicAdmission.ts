/** Host 在途发送屏障；accepted input 和 commandId 幂等仍由 CLI 管理。 */
export function createBotTopicAdmission() {
  const versions = new Map<string, number>();
  const tails = new Map<string, Promise<void>>();
  const capture = (key: string) => versions.get(key) ?? 0;

  return {
    capture,
    async invalidate(key: string): Promise<void> {
      // 先使尚未发送的准备工作失效，再等待已发送的命令收口。
      // 若直接返回，Agent 内部等待连接/上下文的旧命令可能在取消完成后才发出。
      versions.set(key, capture(key) + 1);
      await tails.get(key);
    },
    async run<T>(key: string, version: number, send: () => Promise<T>): Promise<T> {
      const previous = tails.get(key);
      let release!: () => void;
      const tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      tails.set(key, tail);
      try {
        await previous;
        if (version !== capture(key))
          throw new Error("Topic input was cancelled during preparation");
        return await send();
      } finally {
        release();
        if (tails.get(key) === tail) tails.delete(key);
      }
    },
  };
}
