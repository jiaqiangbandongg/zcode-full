import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { gitFileNames } from "./git-file-names.mjs";
import { readUpstreamSnapshot } from "./upstream-snapshot.mjs";

const exec = promisify(execFile);

async function requireMergedCommit(cwd, commit) {
  try {
    await exec("git", ["merge-base", "--is-ancestor", commit, "HEAD"], { cwd });
  } catch (cause) {
    // --no-commit 的合并尚未成为 HEAD 祖先；只接受 Git 当前正在合入的父提交，避免先提交才可检查。
    let mergeHeads = [];
    try {
      const { stdout } = await exec("git", ["rev-parse", "--git-path", "MERGE_HEAD"], { cwd });
      mergeHeads = (await readFile(resolve(cwd, stdout.trim()), "utf8")).trim().split(/\s+/);
    } catch {
      // 没有进行中的合并时，继续按 HEAD 祖先约束拒绝。
    }
    for (const mergeHead of mergeHeads) {
      try {
        await exec("git", ["merge-base", "--is-ancestor", commit, mergeHead], { cwd });
        return;
      } catch {
        // 多父合并逐个核对，不能把任意本地提交当作已合入。
      }
    }
    throw new Error(`上游准入 commit 必须存在且已合入 HEAD 或当前 MERGE_HEAD：${commit}`, {
      cause,
    });
  }
}

const diffOptions = ["--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z"];

/** lint 的存量行数只按当前 Git 两份快照判断，不把一次准入变成永久路径豁免。 */
export async function pristineUpstreamFiles(cwd, admissions, snapshotPath = null) {
  if (snapshotPath) return (await readUpstreamSnapshot(cwd, snapshotPath)).accepted;
  const accepted = new Set();
  const tracked = new Set(await gitFileNames(cwd, ["ls-files", "-z"]));
  for (const { commit, previousHead } of admissions) {
    await Promise.all([requireMergedCommit(cwd, commit), requireMergedCommit(cwd, previousHead)]);
    const [files, workingDifference, stagedDifference] = await Promise.all([
      gitFileNames(cwd, ["ls-tree", "-r", "--name-only", "-z", commit, "--"]),
      gitFileNames(cwd, ["diff", ...diffOptions, commit, "--"]),
      gitFileNames(cwd, ["diff", "--cached", ...diffOptions, commit, "--"]),
    ]);
    const different = new Set([...workingDifference, ...stagedDifference]);
    for (const file of files) {
      if (tracked.has(file) && !different.has(file)) accepted.add(file);
    }
  }
  return accepted;
}

/**
 * 固定上游只接纳原样引入的文件，不改变实际 push 的比较范围。
 * 同时比暂存区和工作区：只比工作区会把“暂存修改后恢复文件”的提交误判为上游原样。
 */
export async function applyUpstreamAdmission(
  cwd,
  { base, candidates, untracked, admissions, eligibleHistoryFiles, snapshotPath = null },
) {
  if (admissions.length === 0 && !snapshotPath) return candidates;
  const required = new Set(candidates);
  const introducedFiles = new Set();
  const accepted = new Set();
  const untrackedSet = new Set(untracked);
  let historical = new Set();
  const [workingChanges, stagedChanges, tracked] = await Promise.all([
    gitFileNames(cwd, ["diff", ...diffOptions, "--diff-filter=ACMRT", base, "--"]),
    gitFileNames(cwd, ["diff", "--cached", ...diffOptions, "--diff-filter=ACMRT", base, "--"]),
    gitFileNames(cwd, ["ls-files", "-z"]),
  ]);
  const changed = new Set([...workingChanges, ...stagedChanges]);
  const trackedSet = new Set(tracked);
  if (snapshotPath) {
    const snapshot = await readUpstreamSnapshot(cwd, snapshotPath);
    historical = snapshot.historical;
    for (const file of snapshot.introduced) {
      if (eligibleHistoryFiles && !eligibleHistoryFiles.has(file)) continue;
      if (!trackedSet.has(file) || untrackedSet.has(file)) continue;
      introducedFiles.add(file);
      if (changed.has(file)) required.add(file);
    }
    for (const file of snapshot.accepted) accepted.add(file);
  }
  for (const { commit, previousHead } of admissions) {
    await Promise.all([requireMergedCommit(cwd, commit), requireMergedCommit(cwd, previousHead)]);
    const [introduced, files, workingDifference, stagedDifference] = await Promise.all([
      gitFileNames(cwd, ["diff", ...diffOptions, "--diff-filter=A", previousHead, commit, "--"]),
      gitFileNames(cwd, ["ls-tree", "-r", "--name-only", "-z", commit, "--"]),
      gitFileNames(cwd, ["diff", ...diffOptions, commit, "--"]),
      gitFileNames(cwd, ["diff", "--cached", ...diffOptions, commit, "--"]),
    ]);
    const different = new Set([...workingDifference, ...stagedDifference]);
    for (const file of introduced) {
      if (eligibleHistoryFiles && !eligibleHistoryFiles.has(file)) continue;
      if (!trackedSet.has(file) || untrackedSet.has(file)) continue;
      introducedFiles.add(file);
      // 首次推送后不再是新增路径，后续编辑仍须退出存量准入并登记模块。
      if (changed.has(file)) required.add(file);
    }
    // 后续上游可原样更新先前引入的路径；仍只对准入历史中的新增路径开放，不扩张到普通旧文件。
    for (const file of files) if (!different.has(file)) accepted.add(file);
  }
  return [...required].filter(
    (file) => !historical.has(file) && (!introducedFiles.has(file) || !accepted.has(file)),
  );
}
