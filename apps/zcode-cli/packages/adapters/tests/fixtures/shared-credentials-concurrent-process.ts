import { createSharedZCodeCredentialStore } from "../../src/auth/shared-credentials.js";

process.send?.({ type: "ready" });

process.once(
  "message",
  async (message: {
    filePath?: unknown;
    keysPerProcess?: unknown;
    operation?: unknown;
    processIndex?: unknown;
    type?: unknown;
  }) => {
    if (
      message.type !== "start" ||
      typeof message.filePath !== "string" ||
      (message.operation !== "read-corrupt" &&
        (typeof message.keysPerProcess !== "number" || typeof message.processIndex !== "number"))
    ) {
      process.send?.({ error: "invalid worker input", type: "error" });
      process.disconnect?.();
      return;
    }

    try {
      const store = createSharedZCodeCredentialStore({
        env: { ZCODE_CREDENTIAL_SECRET: "test-secret" },
        filePath: message.filePath,
      });
      if (message.operation === "read-corrupt") {
        await store.load("corrupt-probe").then(
          () => {
            throw new Error("corrupt credential read unexpectedly succeeded");
          },
          () => undefined,
        );
        process.send?.({ type: "done" }, () => process.disconnect?.());
        return;
      }
      for (let keyIndex = 0; keyIndex < message.keysPerProcess; keyIndex += 1) {
        await store.save(
          `worker-${message.processIndex}:key-${keyIndex}`,
          `value-${message.processIndex}-${keyIndex}`,
        );
      }
      process.send?.({ type: "done" }, () => process.disconnect?.());
    } catch (error) {
      process.send?.(
        {
          error: error instanceof Error ? (error.stack ?? error.message) : String(error),
          type: "error",
        },
        () => process.disconnect?.(),
      );
    }
  },
);
