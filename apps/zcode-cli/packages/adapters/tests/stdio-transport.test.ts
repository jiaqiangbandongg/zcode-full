import { afterEach, describe, expect, it, vi } from "vitest";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const terminateMcpStdioProcessTree = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../src/mcp/process-tree.js", () => ({
  terminateMcpStdioProcessTree,
}));

import { ProcessTreeStdioClientTransport } from "../src/mcp/stdio-transport.js";

describe("ProcessTreeStdioClientTransport Windows fallback", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses the existing taskkill tree cleanup when Job Object attach fails", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    try {
      vi.spyOn(StdioClientTransport.prototype, "start").mockResolvedValue();
      vi.spyOn(StdioClientTransport.prototype, "pid", "get").mockReturnValue(4321);
      const windowsJobObjectFactory = vi.fn(async () => undefined);
      const transport = new ProcessTreeStdioClientTransport(
        { command: process.execPath },
        { windowsJobObjectFactory },
      );
      Object.assign(transport as unknown as { _process: object }, {
        _process: {
          exitCode: null,
          once: vi.fn(),
          pid: 4321,
          signalCode: null,
        },
      });

      await transport.start();
      delete (transport as unknown as { _process?: object })._process;
      const dispose = Object.getOwnPropertyDescriptor(
        ProcessTreeStdioClientTransport.prototype,
        "_dispose",
      )?.value as ((this: ProcessTreeStdioClientTransport) => Promise<void>) | undefined;

      expect(dispose).toBeTypeOf("function");
      await dispose?.call(transport);

      expect(windowsJobObjectFactory).toHaveBeenCalledWith(4321);
      expect(terminateMcpStdioProcessTree).toHaveBeenCalledWith(4321);
    } finally {
      Object.defineProperty(process, "platform", {
        configurable: true,
        value: originalPlatform,
      });
    }
  });
});
