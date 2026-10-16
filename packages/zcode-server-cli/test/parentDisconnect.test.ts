import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { installParentDisconnectHandler } from "../src/server-core/parentDisconnect.js";

describe("Server Core parent disconnect", () => {
  it("runs cleanup when the Supervisor IPC channel disconnects", () => {
    const cleanup = vi.fn();
    const source = new EventEmitter();
    const dispose = installParentDisconnectHandler(cleanup, source);

    source.emit("disconnect");

    expect(cleanup).toHaveBeenCalledOnce();
    dispose();
  });

  it("can remove the handler before a disconnect", () => {
    const cleanup = vi.fn();
    const source = new EventEmitter();
    const dispose = installParentDisconnectHandler(cleanup, source);
    dispose();

    source.emit("disconnect");

    expect(cleanup).not.toHaveBeenCalled();
  });
});
