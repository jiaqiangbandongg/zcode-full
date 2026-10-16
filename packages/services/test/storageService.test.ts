import { describe, expect, it, vi } from "vitest";
import { createStorageService } from "../src/storage/app/storageService.js";
import type {
  FsCleanerPort,
  ScanRunnerPort,
  StorageScanProgress,
  StorageScanRunRequest,
} from "../src/storage/app/ports.js";
import type { StorageRootSpec, StorageUsageSnapshot } from "@zcode/shared";

const homeRoot: StorageRootSpec = { id: "home", path: "/h/.zcode", hasCustomDataBaseDir: false };

function rootUsage(bytes: number) {
  return {
    id: "home" as const,
    path: "/h/.zcode",
    volume: null,
    bytes,
    fileCount: 1,
    categories: [],
  };
}

/** 可手动推进的 runner：测试控制何时上报进度、何时结束。 */
function createManualRunner() {
  const runs: Array<{
    request: StorageScanRunRequest;
    resolve: (progress: StorageScanProgress) => void;
    reject: (error: unknown) => void;
  }> = [];
  const runner: ScanRunnerPort = {
    run: (request) =>
      new Promise((resolve, reject) => {
        request.signal.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
        runs.push({ request, resolve, reject });
      }),
  };
  return { runner, runs };
}

const noopCleaner: FsCleanerPort = {
  listCandidates: async () => [],
  deleteFiles: async () => ({ deletedCount: 0, freedBytes: 0, failures: [] }),
};

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("createStorageService", () => {
  it("emits throttled progress and a terminal complete snapshot for the current job", async () => {
    let clock = 1_000;
    const { runner, runs } = createManualRunner();
    const service = createStorageService({
      roots: { resolveRoots: async () => [homeRoot] },
      scanRunner: runner,
      cleaner: noopCleaner,
      now: () => clock,
      progressThrottleMs: 300,
    });
    const events: StorageUsageSnapshot[] = [];
    service.onScanProgress((snapshot) => events.push(snapshot));

    const { jobId } = await service.startScan();
    expect(jobId).toBe("scan-1");
    await flush();
    const run = runs[0]!;
    run.request.onProgress({ roots: [rootUsage(10)], errors: [] });
    clock += 100;
    run.request.onProgress({ roots: [rootUsage(20)], errors: [] });
    clock += 300;
    run.request.onProgress({ roots: [rootUsage(30)], errors: [] });
    run.resolve({ roots: [rootUsage(40)], errors: [] });
    await flush();

    expect(events.map((event) => [event.status, event.roots[0]?.bytes])).toEqual([
      ["scanning", 10],
      ["scanning", 30],
      ["complete", 40],
    ]);
    expect(await service.getSnapshot()).toMatchObject({ jobId: "scan-1", status: "complete" });
    service.dispose();
  });

  it("cancels the previous job on restart and ignores cancel for non-current jobs", async () => {
    const { runner, runs } = createManualRunner();
    const service = createStorageService({
      roots: { resolveRoots: async () => [homeRoot] },
      scanRunner: runner,
      cleaner: noopCleaner,
      progressThrottleMs: 0,
    });
    const statuses: string[] = [];
    service.onScanProgress((snapshot) => statuses.push(`${snapshot.jobId}:${snapshot.status}`));

    const first = await service.startScan();
    await flush();
    const second = await service.startScan();
    await flush();
    expect(runs[0]!.request.signal.aborted).toBe(true);
    expect(runs[1]!.request.signal.aborted).toBe(false);

    await service.cancelScan(first.jobId);
    expect(runs[1]!.request.signal.aborted).toBe(false);
    await service.cancelScan(second.jobId);
    expect(runs[1]!.request.signal.aborted).toBe(true);
    await flush();

    expect(statuses).toEqual(["scan-1:cancelled", "scan-2:cancelled"]);
    expect((await service.getSnapshot())?.jobId).toBe("scan-2");
    service.dispose();
  });

  it("marks a crashed runner as failed with the error code", async () => {
    const service = createStorageService({
      roots: { resolveRoots: async () => [homeRoot] },
      scanRunner: {
        run: async () => {
          throw Object.assign(new Error("boom"), { code: "EIO" });
        },
      },
      cleaner: noopCleaner,
    });
    await service.startScan();
    await flush();
    expect(await service.getSnapshot()).toMatchObject({
      status: "failed",
      errors: [{ path: "", code: "EIO" }],
    });
  });

  it("cleans through the plan, keeps scope directories and cancels a running scan first", async () => {
    const { runner, runs } = createManualRunner();
    const listCandidates = vi.fn(async () => [
      { relativePath: "cli/debug/model-io-a.jsonl", bytes: 5, mtimeMs: 0 },
      { relativePath: "cli/debug/other.txt", bytes: 5, mtimeMs: 0 },
      { relativePath: "cli/rollout/model-io-b.jsonl", bytes: 7, mtimeMs: 0 },
    ]);
    const deleteFiles = vi.fn(async () => ({ deletedCount: 3, freedBytes: 17, failures: [] }));
    const service = createStorageService({
      roots: { resolveRoots: async () => [homeRoot] },
      scanRunner: runner,
      cleaner: { listCandidates, deleteFiles },
    });
    await service.startScan();
    await flush();
    const result = await service.clean({ rootId: "home", categoryId: "modelTrajectory" });
    expect(runs[0]!.request.signal.aborted).toBe(true);
    expect(listCandidates).toHaveBeenCalledWith("/h/.zcode", [
      { prefix: "cli/debug", recursive: true },
      { prefix: "cli/rollout", recursive: true },
    ]);
    expect(deleteFiles).toHaveBeenCalledWith(
      "/h/.zcode",
      expect.arrayContaining([
        expect.objectContaining({ relativePath: "cli/debug/model-io-a.jsonl" }),
        expect.objectContaining({ relativePath: "cli/rollout/model-io-b.jsonl" }),
      ]),
      { keepDirectories: ["cli/debug", "cli/rollout"] },
    );
    expect(result).toEqual({ deletedCount: 3, freedBytes: 17, failures: [], skippedCount: 0 });
    await expect(service.clean({ rootId: "home", categoryId: "sessionStore" })).rejects.toThrow(
      /not cleanable/,
    );
  });
});
