import { openStartupSqliteSessionStore } from "../../src/storage/index.ts";

process.send?.({ type: "ready" });
process.once("message", (message: { dbPath?: unknown; type?: unknown }) => {
  if (message.type !== "start" || typeof message.dbPath !== "string") {
    process.exitCode = 1;
    process.disconnect?.();
    return;
  }

  try {
    const store = openStartupSqliteSessionStore({ dbPath: message.dbPath });
    const migrationIds = store.debugMigrationIds();
    store.close();
    process.send?.({ result: { migrationIds, ok: true }, type: "result" });
  } catch (error) {
    process.send?.({
      result: {
        kind:
          typeof error === "object" && error !== null && "kind" in error
            ? String(error.kind)
            : undefined,
        message: error instanceof Error ? error.message : String(error),
        ok: false,
      },
      type: "result",
    });
  } finally {
    process.disconnect?.();
  }
});
