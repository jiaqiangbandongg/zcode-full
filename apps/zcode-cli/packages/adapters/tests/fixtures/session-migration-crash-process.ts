import { SqliteSessionStore } from "../../src/storage/session-store/sqlite-session-store.js";

process.once("message", async (input: { dbPath: string; stopAt: "committing" | "ready" }) => {
  await SqliteSessionStore.openStartup(
    { dbPath: input.dbPath },
    {
      onProgress: async (progress) => {
        if (progress.phase !== input.stopAt) return;
        process.send?.({ type: "barrier" });
        // 持续连接 IPC 让父进程在真实事务边界终止此子进程。
        await new Promise<void>(() => {
          process.on("message", () => {});
        });
      },
    },
  );
});
process.send?.({ type: "listening" });
