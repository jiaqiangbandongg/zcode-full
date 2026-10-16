import { spawn } from "node:child_process";
import process from "node:process";
import { resolveSpawnRuntimeOptions } from "../../../scripts/spawn-command.mjs";

function formatStepError(error) {
  return error instanceof Error ? error.message : String(error);
}

function createStepStartFailure(error) {
  return { exitCode: 1, error: formatStepError(error) };
}

function normalizeStepExecution(value) {
  if (value && typeof value === "object" && "result" in value) {
    return {
      result: Promise.resolve(value.result),
      terminate: typeof value.terminate === "function" ? () => value.terminate() : undefined,
    };
  }
  return { result: Promise.resolve(value), terminate: undefined };
}

function normalizeStepResult(result) {
  if (!result || typeof result !== "object") {
    return createStepStartFailure(new Error("step returned no result"));
  }
  return {
    exitCode: Number.isInteger(result.exitCode) ? result.exitCode : 1,
    ...(result.signal ? { signal: String(result.signal) } : {}),
    ...(result.error ? { error: String(result.error) } : {}),
  };
}

export function startStepExecution(runStep, step) {
  let execution;
  try {
    execution = normalizeStepExecution(runStep(step));
  } catch (error) {
    execution = normalizeStepExecution(createStepStartFailure(error));
  }
  return {
    result: execution.result.then(normalizeStepResult, (error) => createStepStartFailure(error)),
    terminate: execution.terminate,
  };
}

export function spawnCancellableStep(step) {
  let child;
  try {
    child = spawn(step.command, step.args, {
      cwd: step.cwd,
      env: step.env,
      stdio: "inherit",
      ...resolveSpawnRuntimeOptions(step.command),
    });
  } catch (error) {
    return {
      result: Promise.resolve(createStepStartFailure(error)),
      terminate() {},
    };
  }

  let forceKillTimer;
  let terminationRequested = false;
  const result = new Promise((resolveRun) => {
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      if (forceKillTimer) clearTimeout(forceKillTimer);
      resolveRun(value);
    };

    // 修复原因：spawn 的 error 过去会 reject Promise.all，导致其他 shard 未等待、manifest 未写入。
    child.once("error", (error) => settle(createStepStartFailure(error)));
    child.once("close", (code, signal) => {
      settle({ exitCode: code ?? 1, signal: signal ?? undefined });
    });
  });

  return {
    result,
    terminate() {
      if (
        terminationRequested ||
        !child.pid ||
        child.exitCode !== null ||
        child.signalCode !== null
      ) {
        return;
      }
      terminationRequested = true;

      if (process.platform === "win32") {
        // pnpm 下还有 WDIO/Electron 等后代进程，Windows 必须按进程树强制终止。
        const killChildFallback = () => {
          try {
            child.kill();
          } catch {
            // 原进程可能已在 taskkill 启动失败前退出。
          }
        };
        let taskkill;
        try {
          taskkill = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
            stdio: "ignore",
            windowsHide: true,
          });
        } catch {
          killChildFallback();
          return;
        }
        taskkill.once("error", killChildFallback);
        taskkill.once("close", (code) => {
          if (code !== 0 && child.exitCode === null && child.signalCode === null) {
            killChildFallback();
          }
        });
        return;
      }

      try {
        child.kill("SIGTERM");
        forceKillTimer = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // SIGTERM 后已经退出时无需继续处理。
          }
        }, 5_000);
        forceKillTimer.unref?.();
      } catch {
        // close/error 会负责产生最终结果，终止请求本身不应绕过收口。
      }
    },
  };
}
