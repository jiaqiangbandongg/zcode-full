import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export function createPromotionProviderFixture(caseName, specPath) {
  return {
    version: 1,
    caseName,
    spec: specPath,
    fixtures: [],
  };
}

export function createPromotionCaseManifest(caseName, specPath) {
  return {
    version: 1,
    caseName,
    spec: specPath,
    providerFixtures: [
      "./test/e2e/fixtures/upstream/common.json",
      `./test/e2e/fixtures/upstream/conversation-session/${caseName}.json`,
    ],
    fileFixtures: [],
    requests: [],
  };
}

export function runPromotionCoverageAudit({ auditPath, repoRoot }) {
  return new Promise((resolveAudit, rejectAudit) => {
    const child = spawn(process.execPath, [auditPath, "--check"], {
      cwd: repoRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", rejectAudit);
    child.on("close", (exitCode, signal) => {
      resolveAudit({
        command: "pnpm audit:conversation-session-coverage",
        exitCode: exitCode ?? 1,
        signal,
        stderr,
        stdout,
      });
    });
  });
}

export async function runPromotionAuditTransaction({ affectedPaths, applyChanges, runAudit }) {
  const snapshots = await Promise.all(affectedPaths.map(captureFileSnapshot));

  try {
    await applyChanges();
    const audit = await runAudit();
    if (audit.exitCode === 0) {
      return { audit, committed: true, rolledBack: false };
    }

    // Bug 根因：promotion 过去会先留下 formal 文件，再由后续命令发现准入失败，
    // 导致 spec、fixture 与 matrix 处于半转正状态；audit 未通过时必须恢复完整快照。
    await restoreFileSnapshots(snapshots);
    return { audit, committed: false, rolledBack: true };
  } catch (error) {
    try {
      await restoreFileSnapshots(snapshots);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "E2E promotion failed and its filesystem rollback also failed.",
      );
    }
    throw error;
  }
}

async function captureFileSnapshot(filePath) {
  try {
    const [content, metadata] = await Promise.all([readFile(filePath), stat(filePath)]);
    return {
      content,
      exists: true,
      filePath,
      mode: metadata.mode,
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { content: null, exists: false, filePath, mode: null };
    }
    throw error;
  }
}

async function restoreFileSnapshots(snapshots) {
  for (const snapshot of snapshots) {
    if (!snapshot.exists) {
      await rm(snapshot.filePath, { force: true });
      continue;
    }
    await mkdir(dirname(snapshot.filePath), { recursive: true });
    await writeFile(snapshot.filePath, snapshot.content);
    await chmod(snapshot.filePath, snapshot.mode);
  }
}
