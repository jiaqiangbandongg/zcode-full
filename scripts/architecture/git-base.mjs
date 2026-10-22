import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { selectDefaultBranchRef } from "../affected-unit-test-baseline.mjs";
import { gitFileNames } from "./git-file-names.mjs";
import { applyUpstreamAdmission } from "./upstream-admission.mjs";

const execFileAsync = promisify(execFile);
const ZERO_SHA = /^0{40}$/;

async function gitOut(cwd, args) {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function hasCommit(cwd, ref) {
  return (
    !!ref &&
    !ZERO_SHA.test(ref) &&
    (await gitOut(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])) !== null
  );
}

function parsePrePushInput(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [localRef, localSha, remoteRef, remoteSha] = line.split(/\s+/);
      return localRef && localSha && remoteRef && remoteSha
        ? { localRef, localSha, remoteRef, remoteSha }
        : null;
    })
    .filter(Boolean);
}

/**
 * 选择 --changed 的比较基线。
 * 修复原因：首版只用 `git diff HEAD`（工作树 vs HEAD）。CI 干净 checkout 与 pre-push 时改动
 * 已提交，差异为空，scoped 违规只剩 cycle 等 global 规则，门禁实际不工作。
 * 架构检查的选择顺序：显式 > CI 变量 > pre-push stdin > upstream > 默认分支 merge-base > HEAD。
 */
export async function resolveDiffBase(
  cwd = process.cwd(),
  { explicit = null, env = process.env } = {},
) {
  const pick = async (ref, label, mergeBase = false) => {
    if (!(await hasCommit(cwd, ref))) return null;
    if (!mergeBase) return { base: ref, label };
    const base = await gitOut(cwd, ["merge-base", "HEAD", ref]);
    return base ? { base, label: `merge-base ${label}` } : null;
  };
  const explicitRef =
    explicit ??
    env.ZCODE_PRE_PUSH_BASE?.trim() ??
    env.ZCODE_AFFECTED_TEST_BASE?.trim() ??
    env.ARCHITECTURE_BASE?.trim();
  if (explicitRef) {
    const chosen = await pick(explicitRef, `explicit ${explicitRef}`, true);
    if (!chosen) throw new Error(`显式 base 不存在或不是 commit: ${explicitRef}`);
    return chosen;
  }
  for (const key of [
    "CI_MERGE_REQUEST_DIFF_BASE_SHA",
    "CI_MERGE_REQUEST_TARGET_BRANCH_SHA",
    "CI_COMMIT_BEFORE_SHA",
  ]) {
    const chosen = await pick(env[key], `${key} ${env[key]}`);
    if (chosen) return chosen;
  }
  const entries = parsePrePushInput(env.ZCODE_PRE_PUSH_STDIN ?? "");
  if (entries.length > 0) {
    const head = await gitOut(cwd, ["rev-parse", "HEAD"]);
    const candidate =
      entries.find((entry) => entry.localSha === head && !ZERO_SHA.test(entry.localSha)) ??
      entries.find((entry) => !ZERO_SHA.test(entry.localSha));
    const chosen =
      candidate && (await pick(candidate.remoteSha, `pre-push remote ${candidate.remoteRef}`));
    if (chosen) return chosen;
  }
  const upstream = await gitOut(cwd, [
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    "@{upstream}",
  ]);
  const viaUpstream = upstream && (await pick(upstream, `upstream ${upstream}`, true));
  if (viaUpstream) return viaUpstream;
  // 架构检查优先 origin/staging，其次 origin/HEAD；
  // 否则长期分支会把 staging 尚未合入 main 的历史差异误算成本分支新增。
  const originHead =
    (await gitOut(cwd, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"])) ?? null;
  const existing = new Set();
  for (const ref of [
    "origin/staging",
    originHead,
    "origin/main",
    "origin/master",
    "main",
    "master",
  ]) {
    if (ref && (await hasCommit(cwd, ref))) existing.add(ref);
  }
  const ref = selectDefaultBranchRef({
    originHead,
    hasCommit: (candidate) => existing.has(candidate),
  });
  const viaDefault = ref && (await pick(ref, ref, true));
  if (viaDefault) return viaDefault;
  return { base: "HEAD", label: "HEAD (仅工作树差异；未找到远端基线)" };
}

export async function changedFilesFromGit(cwd = process.cwd(), { base = "HEAD" } = {}) {
  const [diff, untracked] = await Promise.all([
    gitFileNames(cwd, ["diff", "--name-only", "-z", base]),
    gitFileNames(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  return [...new Set([...diff, ...untracked])];
}

/**
 * 相对 base 新增的文件（含未跟踪）。传入 since 时，只保留"首次进入历史晚于 since"的已跟踪文件，
 * 未跟踪文件永远算新增。since 为空则不过滤。
 */
export async function addedFilesFromGit(
  cwd = process.cwd(),
  {
    base = "HEAD",
    since = null,
    acceptedUpstreamCommits = [],
    acceptedUpstreamSnapshot = null,
  } = {},
) {
  const [added, untracked] = await Promise.all([
    gitFileNames(cwd, ["diff", "--name-only", "-z", "--diff-filter=A", base]),
    gitFileNames(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  const untrackedSet = new Set(untracked);
  let enforced = added;
  let recent = null;
  if (since) {
    recent = new Set(
      await gitFileNames(cwd, [
        "log",
        "--diff-filter=A",
        "--name-only",
        "-z",
        "--format=",
        `--since=${since}`,
        "HEAD",
      ]),
    );
    enforced = added.filter((file) => untrackedSet.has(file) || recent.has(file));
  }
  return applyUpstreamAdmission(cwd, {
    base,
    candidates: [...new Set([...enforced, ...untracked])],
    untracked,
    admissions: acceptedUpstreamCommits,
    snapshotPath: acceptedUpstreamSnapshot,
    eligibleHistoryFiles: recent,
  });
}
