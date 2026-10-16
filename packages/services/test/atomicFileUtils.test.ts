import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { mkdir, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fsMockState = vi.hoisted(() => ({
  renameFailures: [] as NodeJS.ErrnoException[],
  lockRemoveFailure: null as NodeJS.ErrnoException | null,
  renameDelayMs: 0,
  activeRenames: 0,
  maxActiveRenames: 0,
  lockMkdirGate: null as Promise<void> | null,
  lockMkdirEntered: null as (() => void) | null,
}));

vi.mock("node:fs/promises", async () => {
  const actual =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  return {
    ...actual,
    mkdir: vi.fn(
      async (...args: Parameters<typeof actual.mkdir>) => {
        const gate = fsMockState.lockMkdirGate;
        if (gate && String(args[0]).endsWith(".lock")) {
          fsMockState.lockMkdirEntered?.();
          fsMockState.lockMkdirEntered = null;
          await gate;
        }
        return actual.mkdir(...args);
      },
    ),
    rename: vi.fn(
      async (
        oldPath: Parameters<typeof actual.rename>[0],
        newPath: Parameters<typeof actual.rename>[1],
      ) => {
        const failure = fsMockState.renameFailures.shift();
        if (failure) {
          throw failure;
        }
        fsMockState.activeRenames += 1;
        fsMockState.maxActiveRenames = Math.max(
          fsMockState.maxActiveRenames,
          fsMockState.activeRenames,
        );
        try {
          if (fsMockState.renameDelayMs > 0) {
            await new Promise((resolve) =>
              setTimeout(resolve, fsMockState.renameDelayMs),
            );
          }
          await actual.rename(oldPath, newPath);
        } finally {
          fsMockState.activeRenames -= 1;
        }
      },
    ),
    rm: vi.fn(
      async (
        path: Parameters<typeof actual.rm>[0],
        options?: Parameters<typeof actual.rm>[1],
      ) => {
        if (String(path).includes(".lock") && fsMockState.lockRemoveFailure) {
          throw fsMockState.lockRemoveFailure;
        }
        await actual.rm(path, options);
      },
    ),
  };
});

import { atomicWriteText } from "../src/fs/atomicFileUtils.js";
import {
  createFsFaultInjector,
  resetProcessFsFaultInjectorForTests,
  setFsFaultInjectorForTests,
} from "../src/fs/fsFaultInjection.js";

function createFsError(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

function pauseNextLockMkdir(): {
  entered: Promise<void>;
  release: () => void;
} {
  let release!: () => void;
  let markEntered!: () => void;
  fsMockState.lockMkdirGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  fsMockState.lockMkdirEntered = markEntered;
  return {
    entered,
    release: () => {
      fsMockState.lockMkdirGate = null;
      release();
    },
  };
}

function createDirectoryLock(
  filePath: string,
  metadata: { createdAt: number; pid: number; token: string },
) {
  const lockDir = `${filePath}.lock`;
  mkdirSync(lockDir);
  const ownerFile = join(lockDir, `owner-${metadata.token}.json`);
  writeFileSync(ownerFile, `${JSON.stringify(metadata)}\n`, "utf-8");
  return ownerFile;
}

describe("atomicWriteText", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "zcode-atomic-write-"));
    fsMockState.renameFailures.length = 0;
    fsMockState.lockRemoveFailure = null;
    fsMockState.renameDelayMs = 0;
    fsMockState.activeRenames = 0;
    fsMockState.maxActiveRenames = 0;
    fsMockState.lockMkdirGate = null;
    fsMockState.lockMkdirEntered = null;
    vi.mocked(mkdir).mockClear();
    vi.mocked(rename).mockClear();
  });

  afterEach(() => {
    resetProcessFsFaultInjectorForTests();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("retries transient Windows rename locks and keeps the atomic temp file clean", async () => {
    const filePath = join(tempDir, "session.json");
    fsMockState.renameFailures.push(
      createFsError("EPERM"),
      createFsError("EBUSY"),
    );

    await atomicWriteText(filePath, "saved\n", {
      renameRetryDelaysMs: [1, 1],
    });

    expect(readFileSync(filePath, "utf-8")).toBe("saved\n");
    expect(vi.mocked(rename)).toHaveBeenCalledTimes(3);
    expect(
      readdirSync(tempDir).filter((name) => name.endsWith(".tmp")),
    ).toEqual([]);
  });

  it("does not retry non-transient rename failures and removes the temp file", async () => {
    const filePath = join(tempDir, "session.json");
    fsMockState.renameFailures.push(createFsError("ENOENT"));

    await expect(
      atomicWriteText(filePath, "saved\n", {
        renameRetryDelaysMs: [1],
      }),
    ).rejects.toMatchObject({ code: "ENOENT" });

    expect(vi.mocked(rename)).toHaveBeenCalledTimes(1);
    expect(
      readdirSync(tempDir).filter((name) => name.endsWith(".tmp")),
    ).toEqual([]);
  });

  it("fails immediately on injected fs faults before atomic rename", async () => {
    const filePath = join(tempDir, "config.json");
    const injector = createFsFaultInjector([
      {
        code: "EACCES",
        id: "D03-provider-settings-eacces",
        operations: ["rename"],
        pathEndsWith: "/config.json",
      },
    ]);
    setFsFaultInjectorForTests(injector);

    await expect(
      atomicWriteText(filePath, "blocked\n", {
        renameRetryDelaysMs: [1, 1],
      }),
    ).rejects.toMatchObject({
      code: "EACCES",
      path: filePath,
      syscall: "rename",
      zcodeFsFaultId: "D03-provider-settings-eacces",
    });

    expect(vi.mocked(rename)).toHaveBeenCalledTimes(0);
    expect(existsSync(filePath)).toBe(false);
    expect(
      readdirSync(tempDir).filter((name) => name.endsWith(".tmp")),
    ).toEqual([]);
    expect(injector.getHits()).toMatchObject([
      {
        code: "EACCES",
        id: "D03-provider-settings-eacces",
        matchIndex: 1,
        operation: "rename",
        path: filePath,
      },
    ]);
  });

  it("serializes concurrent writes to the same target with a cooperative lock", async () => {
    const filePath = join(tempDir, "session.json");
    fsMockState.renameDelayMs = 20;

    await Promise.all([
      atomicWriteText(filePath, "first\n", {
        lockRetryDelaysMs: [1, 5, 20, 20],
      }),
      atomicWriteText(filePath, "second\n", {
        lockRetryDelaysMs: [1, 5, 20, 20],
      }),
    ]);

    expect(["first\n", "second\n"]).toContain(readFileSync(filePath, "utf-8"));
    expect(fsMockState.maxActiveRenames).toBe(1);
    expect(
      readdirSync(tempDir).filter((name) => name.endsWith(".tmp")),
    ).toEqual([]);
    expect(
      readdirSync(tempDir).filter((name) => name.endsWith(".lock")),
    ).toEqual([]);
  });

  it("reclaims a fresh lock when its owner process has already exited", async () => {
    const filePath = join(tempDir, "config.json");
    writeFileSync(
      `${filePath}.lock`,
      `${JSON.stringify({ pid: 2_147_483_647, createdAt: Date.now() })}\n`,
      "utf-8",
    );

    await atomicWriteText(filePath, "saved\n", {
      lockRetryDelaysMs: [1],
      lockOwnerlessGraceMs: 60_000,
    });

    expect(readFileSync(filePath, "utf-8")).toBe("saved\n");
    expect(existsSync(`${filePath}.lock`)).toBe(false);
  });

  it("reclaims a fresh empty lock directory within the current wait budget", async () => {
    const filePath = join(tempDir, "config.json");
    const lockDir = `${filePath}.lock`;
    mkdirSync(lockDir);
    await atomicWriteText(filePath, "saved\n", {
      lockRetryDelaysMs: [1],
      lockOwnerlessGraceMs: 30_000,
      lockMaxWaitMs: 100,
    });

    expect(readFileSync(filePath, "utf-8")).toBe("saved\n");
    expect(existsSync(lockDir)).toBe(false);
  });

  it("bounds a future empty lock directory mtime by the current wait budget", async () => {
    const filePath = join(tempDir, "config-future-lock-dir.json");
    const lockDir = `${filePath}.lock`;
    mkdirSync(lockDir);
    const futureTime = new Date(Date.now() + 24 * 60 * 60_000);
    utimesSync(lockDir, futureTime, futureTime);

    await atomicWriteText(filePath, "saved\n", {
      lockRetryDelaysMs: [1],
      lockOwnerlessGraceMs: 30_000,
      lockMaxWaitMs: 100,
    });

    expect(readFileSync(filePath, "utf-8")).toBe("saved\n");
    expect(existsSync(lockDir)).toBe(false);
  });

  it("does not apply an old waiter's age to a replacement empty lock directory", async () => {
    const filePath = join(tempDir, "config-replacement-empty.json");
    const lockDir = `${filePath}.lock`;
    createDirectoryLock(filePath, {
      pid: process.pid,
      createdAt: Date.now(),
      token: "old-owner",
    });

    let settled = false;
    const writePromise = atomicWriteText(filePath, "saved\n", {
      lockRetryDelaysMs: [1],
      lockOwnerlessGraceMs: 1_000,
      lockMaxWaitMs: 240,
    });
    void writePromise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 145));
    expect(settled).toBe(false);

    const mkdirGate = pauseNextLockMkdir();
    await mkdirGate.entered;
    rmSync(lockDir, { recursive: true, force: true });
    mkdirSync(lockDir);
    mkdirGate.release();

    await expect(writePromise).rejects.toMatchObject({
      code: "ZCODE_FILE_LOCK_TIMEOUT",
    });
    expect(existsSync(lockDir)).toBe(true);
    expect(existsSync(filePath)).toBe(false);
  });

  it("does not apply an old waiter's age to a replacement damaged ownerless lock", async () => {
    const filePath = join(tempDir, "config-replacement-ownerless.json");
    const lockFile = `${filePath}.lock`;
    createDirectoryLock(filePath, {
      pid: process.pid,
      createdAt: Date.now(),
      token: "old-owner",
    });

    let settled = false;
    const writePromise = atomicWriteText(filePath, "saved\n", {
      lockRetryDelaysMs: [1],
      lockOwnerlessGraceMs: 1_000,
      lockMaxWaitMs: 240,
    });
    void writePromise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 145));
    expect(settled).toBe(false);

    const mkdirGate = pauseNextLockMkdir();
    await mkdirGate.entered;
    rmSync(lockFile, { recursive: true, force: true });
    writeFileSync(lockFile, '{"pid":0,"createdAt":1e999}\n', "utf-8");
    const futureTime = new Date(Date.now() + 24 * 60 * 60_000);
    utimesSync(lockFile, futureTime, futureTime);
    mkdirGate.release();

    await expect(writePromise).rejects.toMatchObject({
      code: "ZCODE_FILE_LOCK_TIMEOUT",
    });
    expect(existsSync(lockFile)).toBe(true);
    expect(existsSync(filePath)).toBe(false);
  });

  it.each(["0", "-1", "1.5", "1e999"])(
    "reclaims a stale lock with invalid pid %s as ownerless",
    async (rawPid) => {
      const filePath = join(
        tempDir,
        `config-${rawPid.replace(/\W/g, "_")}.json`,
      );
      const createdAt = Date.now();
      writeFileSync(
        `${filePath}.lock`,
        `{"pid":${rawPid},"createdAt":${createdAt}}\n`,
        "utf-8",
      );

      await atomicWriteText(filePath, "saved\n", {
        lockRetryDelaysMs: [1],
        lockOwnerlessGraceMs: 30_000,
        lockMaxWaitMs: 100,
      });

      expect(readFileSync(filePath, "utf-8")).toBe("saved\n");
      expect(existsSync(`${filePath}.lock`)).toBe(false);
    },
  );

  it.each([
    ["non-finite", "1e999"],
    ["negative", "-1"],
    ["far-future", String(Date.now() + 24 * 60 * 60_000)],
  ])(
    "reclaims an ownerless stale lock with %s createdAt via file mtime",
    async (label, rawCreatedAt) => {
      const filePath = join(tempDir, `config-created-at-${label}.json`);
      const lockFile = `${filePath}.lock`;
      writeFileSync(
        lockFile,
        `{"pid":0,"createdAt":${rawCreatedAt}}\n`,
        "utf-8",
      );
      const oldTime = new Date(Date.now() - 60_000);
      utimesSync(lockFile, oldTime, oldTime);

      await atomicWriteText(filePath, "saved\n", {
        lockRetryDelaysMs: [1],
        lockOwnerlessGraceMs: 10,
        lockMaxWaitMs: 100,
      });

      expect(readFileSync(filePath, "utf-8")).toBe("saved\n");
      expect(existsSync(lockFile)).toBe(false);
    },
  );

  it("reclaims a lock with invalid metadata and mtime from its first observation", async () => {
    const filePath = join(tempDir, "config-invalid-timestamps.json");
    const lockFile = `${filePath}.lock`;
    writeFileSync(lockFile, '{"pid":0,"createdAt":1e999}\n', "utf-8");
    const futureTime = new Date(Date.now() + 24 * 60 * 60_000);
    utimesSync(lockFile, futureTime, futureTime);

    await atomicWriteText(filePath, "saved\n", {
      lockRetryDelaysMs: [1],
      lockOwnerlessGraceMs: 20,
      lockMaxWaitMs: 100,
    });

    expect(readFileSync(filePath, "utf-8")).toBe("saved\n");
    expect(existsSync(lockFile)).toBe(false);
  });

  it("does not reclaim a stale-looking lock while its owner is still alive", async () => {
    const filePath = join(tempDir, "config.json");
    const ownerFile = createDirectoryLock(filePath, {
      pid: process.pid,
      createdAt: Date.now() - 60_000,
      token: "live-owner",
    });

    await expect(
      atomicWriteText(filePath, "saved\n", {
        lockRetryDelaysMs: [1],
        lockOwnerlessGraceMs: 10,
        lockMaxWaitMs: 20,
      }),
    ).rejects.toMatchObject({ code: "ZCODE_FILE_LOCK_TIMEOUT" });

    expect(readFileSync(ownerFile, "utf-8")).toContain('"token":"live-owner"');
    expect(existsSync(filePath)).toBe(false);
  });

  it("does not delete a fresh owner that replaces the lock while a waiter is near timeout", async () => {
    const filePath = join(tempDir, "config.json");
    createDirectoryLock(filePath, {
      pid: process.pid,
      createdAt: Date.now(),
      token: "old-owner",
    });

    const writePromise = atomicWriteText(filePath, "saved\n", {
      lockRetryDelaysMs: [1],
      lockOwnerlessGraceMs: 40,
      lockMaxWaitMs: 65,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const mkdirGate = pauseNextLockMkdir();
    await mkdirGate.entered;
    rmSync(`${filePath}.lock`, { recursive: true, force: true });
    const freshOwnerFile = createDirectoryLock(filePath, {
      pid: process.pid,
      createdAt: Date.now(),
      token: "fresh-owner",
    });
    mkdirGate.release();

    await expect(writePromise).rejects.toMatchObject({
      code: "ZCODE_FILE_LOCK_TIMEOUT",
    });
    expect(readFileSync(freshOwnerFile, "utf-8")).toContain(
      '"token":"fresh-owner"',
    );
    expect(existsSync(filePath)).toBe(false);
  });

  it("stops waiting with an explicit lock timeout", async () => {
    const filePath = join(tempDir, "config.json");
    writeFileSync(
      `${filePath}.lock`,
      `${JSON.stringify({ pid: process.pid, createdAt: Date.now() })}\n`,
      "utf-8",
    );

    await expect(
      atomicWriteText(filePath, "saved\n", {
        lockRetryDelaysMs: [1],
        lockOwnerlessGraceMs: 60_000,
        lockMaxWaitMs: 10,
      }),
    ).rejects.toMatchObject({
      code: "ZCODE_FILE_LOCK_TIMEOUT",
      path: filePath,
      syscall: "mkdir",
    });
  });

  it("preserves permission errors when an abandoned lock cannot be removed", async () => {
    const filePath = join(tempDir, "config.json");
    const oldCreatedAt = Date.now() - 60_000;
    writeFileSync(
      `${filePath}.lock`,
      `${JSON.stringify({ pid: 2_147_483_647, createdAt: oldCreatedAt })}\n`,
      "utf-8",
    );
    fsMockState.lockRemoveFailure = createFsError("EACCES");

    await expect(
      atomicWriteText(filePath, "saved\n", {
        lockRetryDelaysMs: [1],
        lockOwnerlessGraceMs: 10,
        lockMaxWaitMs: 10,
      }),
    ).rejects.toMatchObject({ code: "EACCES" });
  });

  it("removes stale temp files for the same target without deleting fresh temp files", async () => {
    const filePath = join(tempDir, "config.json");
    const staleTemp = join(tempDir, "config.json.123.1000.stale.tmp");
    const freshTemp = join(tempDir, "config.json.123.1000.fresh.tmp");
    writeFileSync(staleTemp, "stale\n", "utf-8");
    writeFileSync(freshTemp, "fresh\n", "utf-8");
    const oldTime = new Date(Date.now() - 120_000);
    utimesSync(staleTemp, oldTime, oldTime);

    await atomicWriteText(filePath, "saved\n", {
      lockOwnerlessGraceMs: 60_000,
      tempFileStaleMs: 60_000,
    });

    const files = readdirSync(tempDir);
    expect(files).not.toContain("config.json.123.1000.stale.tmp");
    expect(files).toContain("config.json.123.1000.fresh.tmp");
  });
});
