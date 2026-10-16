import { describe, expect, it } from "vitest";
import type { ZCodeApp } from "../src/app/types.js";
import { runSessionModelConfigMutation } from "../src/zcode-protocol-v4/model-config-mutation.js";

describe("session model config mutation coordinator", () => {
  it("serializes registry fallback and explicit model mutations by session App identity", async () => {
    const app = {} as ZCodeApp;
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = runSessionModelConfigMutation(app, async () => {
      order.push("fallback:start");
      await firstBlocked;
      order.push("fallback:end");
    });
    const second = runSessionModelConfigMutation(app, async () => {
      order.push("explicit:start");
      order.push("explicit:end");
    });

    await new Promise<void>((resolve) => {
      queueMicrotask(() => queueMicrotask(resolve));
    });
    expect(order).toEqual(["fallback:start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["fallback:start", "fallback:end", "explicit:start", "explicit:end"]);
  });

  it("does not poison later model mutations when one operation fails", async () => {
    const app = {} as ZCodeApp;
    const failed = runSessionModelConfigMutation(app, async () => {
      throw new Error("expected failure");
    });
    const recovered = runSessionModelConfigMutation(app, async () => "recovered");

    await expect(failed).rejects.toThrow("expected failure");
    await expect(recovered).resolves.toBe("recovered");
  });
});
