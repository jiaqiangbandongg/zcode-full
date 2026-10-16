import { open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  replaceE2EFileWithRetry,
  writeE2EJsonFileAtomically,
} from "./e2e/helpers/e2e-atomic-json-file.js";

describe("Desktop E2E atomic JSON file", () => {
  it("writes a complete temporary JSON file before replacing the capture artifact", async () => {
    const mkdir = vi.fn();
    const rename = vi.fn();
    const remove = vi.fn();
    const write = vi.fn();

    await writeE2EJsonFileAtomically(
      "C:/e2e/capture.json",
      { records: [{ id: "record-1" }], version: 1 },
      { mkdir, remove, rename, wait: vi.fn(), write },
    );

    const temporaryPath = write.mock.calls[0]?.[0] as string;
    expect(temporaryPath).not.toBe("C:/e2e/capture.json");
    expect(temporaryPath).toContain("capture.json.");
    expect(JSON.parse(write.mock.calls[0]?.[1] as string)).toEqual({
      records: [{ id: "record-1" }],
      version: 1,
    });
    expect(rename).toHaveBeenCalledWith(temporaryPath, "C:/e2e/capture.json");
    expect(remove).not.toHaveBeenCalled();
  });

  it("retries a transient Windows replacement conflict before succeeding", async () => {
    const conflict = Object.assign(new Error("file is busy"), { code: "EPERM" });
    const rename = vi.fn().mockRejectedValueOnce(conflict).mockResolvedValueOnce(undefined);
    const wait = vi.fn().mockResolvedValue(undefined);

    await writeE2EJsonFileAtomically(
      "C:/e2e/capture.json",
      { records: [] },
      {
        mkdir: vi.fn(),
        remove: vi.fn(),
        rename,
        wait,
        write: vi.fn(),
      },
    );

    expect(rename).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledTimes(1);
  });

  it("reuses the bounded replacement retry for non-JSON E2E fixtures", async () => {
    const conflict = Object.assign(new Error("file is busy"), { code: "EACCES" });
    const rename = vi.fn().mockRejectedValueOnce(conflict).mockResolvedValueOnce(undefined);
    const wait = vi.fn().mockResolvedValue(undefined);

    await replaceE2EFileWithRetry("memory.md.replacement", "memory.md", {
      rename,
      wait,
    });

    expect(rename).toHaveBeenNthCalledWith(1, "memory.md.replacement", "memory.md");
    expect(rename).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledTimes(1);
  });

  it("removes the temporary file when replacement fails", async () => {
    const remove = vi.fn();
    const rename = vi.fn(() => {
      throw new Error("rename failed");
    });
    const write = vi.fn();

    await expect(
      writeE2EJsonFileAtomically(
        "/e2e/capture.json",
        { records: [] },
        { mkdir: vi.fn(), remove, rename, wait: vi.fn(), write },
      ),
    ).rejects.toThrow("rename failed");

    expect(remove).toHaveBeenCalledWith(write.mock.calls[0]?.[0], {
      force: true,
    });
  });

  it.runIf(process.platform === "win32")(
    "waits until a Windows reader releases the previous capture artifact",
    async () => {
      const artifactPath = join(tmpdir(), `zcode-e2e-atomic-${process.pid}.json`);
      await writeFile(artifactPath, JSON.stringify({ version: "old" }), "utf-8");
      const reader = await open(artifactPath, "r");
      const releaseReader = setTimeout(() => {
        void reader.close().catch(() => undefined);
      }, 75);

      try {
        await writeE2EJsonFileAtomically(artifactPath, { version: "new" });
        await expect(readFile(artifactPath, "utf-8")).resolves.toContain('"new"');
      } finally {
        clearTimeout(releaseReader);
        await reader.close().catch(() => undefined);
        await rm(artifactPath, { force: true });
      }
    },
  );
});
