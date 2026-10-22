import {
  getTasksIndexDatabasePath,
  markTasksStoragePrepared,
  resolveZCodeAgentSpawnCwd,
} from "@zcode/services/storage-startup";
import type { DatabaseStartupState } from "@zcode/shared";
import { DatabaseStartupCoordinator } from "../databaseStartupCoordinator.js";
import { StartupDiskSampler } from "../startupDiskSampler.js";
import { prepareHostStorage, prepareSessionStorage } from "./storagePreparationProcesses.js";

const BASELINE_BUDGET_MS = 250;
export function createHostDatabaseStartup(options: {
  startupId?: string;
  cwd: string;
  workingDirectories?: string[];
  env?: Record<string, string>;
  publish: (state: DatabaseStartupState) => void;
  initializeServices: () => Promise<void>;
  onFailure: (error: unknown) => void;
}) {
  const abort = new AbortController();
  let sampler: StartupDiskSampler | undefined;
  const coordinator = new DatabaseStartupCoordinator({
    startupId: options.startupId,
    publish: options.publish,
    prepare: async (report) => {
      const preparedPaths = new Set<string>();
      sampler = new StartupDiskSampler({ onSample: (disk) => coordinator.updateDisk(disk) });
      const currentSampler = sampler;
      const observePath = async (path: string) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            currentSampler.addPath(path),
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, BASELINE_BUDGET_MS);
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
        currentSampler.sealBaseline(path);
        coordinator.updateDisk(currentSampler.snapshot());
      };
      try {
        report("preparing_host_storage", "checking");
        const tasksPath = getTasksIndexDatabasePath();
        await observePath(tasksPath);
        currentSampler.start();
        await prepareHostStorage(
          tasksPath,
          (phase, migration) =>
            report("preparing_host_storage", phase, { databaseId: "tasks-index", migration }),
          abort.signal,
        );
        markTasksStoragePrepared(tasksPath);
        report("preparing_session_storage", "checking");
        const candidates = options.workingDirectories?.length
          ? options.workingDirectories
          : [options.cwd];
        const directories = new Set<string>();
        for (const candidate of candidates) {
          // 历史项目 ENOTDIR/无权限不是数据库失败；与普通 Agent 使用同一 cwd 选择规则。
          const { cwd } = await resolveZCodeAgentSpawnCwd({
            requestedCwd: candidate,
            workspacePath: candidate,
            spawnFallbackCwd: options.cwd,
          });
          directories.add(cwd);
        }
        // 相对 sessionDbPath 按实际进程 cwd 解析；不能先准备 fallback 下的另一个空库。
        const pendingDirectories = [...directories];
        for (const [index, cwd] of pendingDirectories.entries())
          await prepareSessionStorage({
            cwd,
            env: options.env,
            signal: abort.signal,
            preparedPaths,
            report: (phase, details) =>
              report("preparing_session_storage", phase, {
                databaseId: details?.databaseId ?? "session",
                migration: details?.migration,
                finalDatabase: index === pendingDirectories.length - 1,
              }),
            observePath,
          });
        report("starting_services");
        await options.initializeServices();
      } catch (error) {
        try {
          options.onFailure(error);
        } catch {
          /* 诊断失败不覆盖原始错误。 */
        }
        throw error;
      } finally {
        currentSampler.stop();
        coordinator.updateDisk(currentSampler.snapshot());
      }
    },
  });
  return {
    coordinator,
    dispose: () => {
      abort.abort();
      sampler?.stop();
    },
  };
}
