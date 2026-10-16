import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildMcpStdioEnv,
  prependRunningNodeDirectory,
} from "../src/mcp/network.js";

describe("MCP stdio environment", () => {
  it("prepends the running Node directory so portable node commands work remotely", () => {
    const originalPath = ["/definitely/missing/bin", "/also/missing/bin"].join(delimiter);

    const env = buildMcpStdioEnv({
      env: {
        PATH: originalPath,
      },
    });

    expect(env.PATH).toBe([dirname(process.execPath), originalPath].join(delimiter));
  });

  it("preserves an existing PATH when another executable node is already available", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-mcp-node-path-"));
    const nodePath = join(root, "node");
    try {
      await writeFile(nodePath, "#!/bin/sh\nexit 0\n");
      await chmod(nodePath, 0o755);

      const env = buildMcpStdioEnv({ env: { PATH: root } });

      expect(env.PATH).toBe(root);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("normalizes Windows separators and case before adding the running node directory", () => {
    const env = prependRunningNodeDirectory(
      { Path: "C:\\ZCode\\Node;C:\\Windows\\System32" },
      {
        execPath: "c:/zcode/node/node.exe",
        isExecutable: () => false,
        platform: "win32",
      },
    );

    expect(env).toEqual({ Path: "C:\\ZCode\\Node;C:\\Windows\\System32" });
  });
});
