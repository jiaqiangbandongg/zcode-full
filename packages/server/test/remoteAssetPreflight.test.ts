import { PassThrough } from "node:stream";

import type { IDisposable, Event } from "@zcode/rpc";
import type {
  IRemoteBackend,
  StdioStream,
} from "@zcode/server/remote/backend.js";
import { detectRemoteAssetTools } from "@zcode/server/remote/remoteAssetPreflight.js";
import { describe, expect, it } from "vitest";

interface PreflightBackendOptions {
  closeBeforeStdoutEnd?: boolean;
  stdoutAfterClose?: boolean;
}

class PreflightBackend implements IRemoteBackend {
  constructor(
    private readonly stdoutText: string,
    private readonly options: PreflightBackendOptions = {},
  ) {}

  dispose(): void {}

  async detect() {
    return { platform: "linux", arch: "x64" };
  }

  async upload(): Promise<void> {}

  async exists(): Promise<boolean> {
    return false;
  }

  async readFile(): Promise<string> {
    throw new Error("readFile should not be called in preflight tests");
  }

  async exec(command: string): Promise<StdioStream> {
    expect(command).toContain("command -v");
    return createClosedStream(this.stdoutText, this.options);
  }
}

function createClosedStream(
  stdoutText: string,
  options: PreflightBackendOptions = {},
): StdioStream {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const closeListeners = new Set<(code: number) => void>();
  let closedCode: number | null = null;
  let closeScheduled = false;

  const scheduleClose = () => {
    if (closeScheduled) {
      return;
    }
    closeScheduled = true;
    queueMicrotask(() => {
      const writeStdout = () => {
        stdout.write(stdoutText);
        if (!options.closeBeforeStdoutEnd) {
          stdout.end();
        }
      };

      if (!options.stdoutAfterClose) {
        writeStdout();
      }
      closedCode = 0;
      stderr.end();
      for (const listener of closeListeners) {
        listener(closedCode);
      }
      if (options.stdoutAfterClose) {
        setTimeout(writeStdout, 0);
      }
    });
  };

  const onClose: Event<number> = (listener: (code: number) => void): IDisposable => {
    if (closedCode !== null) {
      queueMicrotask(() => listener(closedCode));
      return { dispose() {} };
    }
    closeListeners.add(listener);
    scheduleClose();
    return {
      dispose() {
        closeListeners.delete(listener);
      },
    };
  };
  return { stdin, stdout, stderr, onClose };
}

describe("detectRemoteAssetTools", () => {
  it("selects one tool from each required capability", async () => {
    const tools = await detectRemoteAssetTools(
      new PreflightBackend("download=wget\ntar=tar\nsha256=shasum\n"),
      { log: () => undefined },
    );

    expect(tools).toEqual({ download: "wget", tar: "tar", sha256: "shasum" });
  });

  it("fails clearly when no download tool exists", async () => {
    await expect(
      detectRemoteAssetTools(
        new PreflightBackend("download=\ntar=tar\nsha256=sha256sum\n"),
        { log: () => undefined },
      ),
    ).rejects.toThrow("远端服务器缺少 curl 或 wget");
  });

  it("fails clearly when tar is missing", async () => {
    await expect(
      detectRemoteAssetTools(
        new PreflightBackend("download=curl\ntar=\nsha256=sha256sum\n"),
        { log: () => undefined },
      ),
    ).rejects.toThrow("远端服务器缺少 tar");
  });

  it("fails clearly when no checksum tool exists", async () => {
    await expect(
      detectRemoteAssetTools(
        new PreflightBackend("download=curl\ntar=tar\nsha256=\n"),
        { log: () => undefined },
      ),
    ).rejects.toThrow("远端服务器缺少 sha256sum、shasum 或 openssl");
  });

  it("does not hang when close fires before stdout end", async () => {
    const tools = await Promise.race([
      detectRemoteAssetTools(
        new PreflightBackend(
          "download=curl\ntar=tar\nsha256=openssl\n",
          { closeBeforeStdoutEnd: true },
        ),
        { log: () => undefined },
      ),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("preflight timed out")), 200);
      }),
    ]);

    expect(tools).toEqual({ download: "curl", tar: "tar", sha256: "openssl" });
  });

  it("keeps collecting stdout when close fires before data", async () => {
    const tools = await detectRemoteAssetTools(
      new PreflightBackend(
        "download=curl\ntar=tar\nsha256=sha256sum\n",
        { stdoutAfterClose: true },
      ),
      { log: () => undefined },
    );

    expect(tools).toEqual({
      download: "curl",
      tar: "tar",
      sha256: "sha256sum",
    });
  });
});
