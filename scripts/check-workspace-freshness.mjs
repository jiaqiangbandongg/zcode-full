#!/usr/bin/env node
// 开工前基线新鲜度检查 —— 当前分支落后自己的远端、或（非特性分支时）落后
// origin/main 超阈值，直接失败，防止在旧架构上分析、写测试、修已经消失的问题。
//
// 背景：本地 zcode-cua 曾落后 origin/main 140 个提交（本地 Skill 仍
// 558 行、主线已收敛到 128 行），z-code 集成分支曾落后自己的远端 29 个提交，都曾在
// 旧基线上开工。任何会话开始前先跑本脚本（zcode-cua 仓库用它的 python 等价物）。
//
// 判定规则：
//   1) 落后自己的远端跟踪分支（任何数量）→ 失败：先 git merge --ff-only <upstream>。
//   2) ahead==0 且落后 origin/main 超阈值 → 失败：本地 main 类分支纯过期。
//   3) ahead>0（特性/MR 分支）且落后 origin/main 超阈值 → 警告不失败：分叉是正常的，
//      但数字会打出来，由你决定是否 rebase（有未合并的草稿变更时不要盲目 rebase）。
//
// 用法：node scripts/check-workspace-freshness.mjs [--max-behind-main 50] [--no-fetch]

import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const args = process.argv.slice(2);
const maxBehindMainIndex = args.indexOf("--max-behind-main");
const maxBehindMain =
  maxBehindMainIndex >= 0 ? Number(args[maxBehindMainIndex + 1]) : 50;
if (!Number.isInteger(maxBehindMain) || maxBehindMain < 0) {
  console.error("[freshness] --max-behind-main 需要一个非负整数");
  process.exit(2);
}
const doFetch = !args.includes("--no-fetch");

async function git(...gitArgs) {
  const { stdout } = await execFile("git", gitArgs, { encoding: "utf8" });
  return stdout.trim();
}

if (doFetch) {
  await git("fetch", "origin", "--prune");
}

const branch = await git("rev-parse", "--abbrev-ref", "HEAD");
let upstream = null;
try {
  upstream = await git("rev-parse", "--abbrev-ref", "@{upstream}");
} catch {
  console.warn(
    `[freshness] ${branch} 没有远端跟踪分支，跳过 behind-remote 检查（是否忘了 push -u？）`,
  );
}

const failures = [];
if (upstream) {
  const behindRemote = Number(await git("rev-list", "--count", `HEAD..${upstream}`));
  if (behindRemote > 0) {
    failures.push(
      `${branch} 落后 ${upstream} ${behindRemote} 个提交：先 git merge --ff-only ${upstream}`,
    );
  }
}

let mainReport = "";
try {
  await git("rev-parse", "--verify", "origin/main^{commit}");
  const aheadMain = Number(
    await git("rev-list", "--count", `origin/main..HEAD`),
  );
  const behindMain = Number(
    await git("rev-list", "--count", `HEAD..origin/main`),
  );
  mainReport = `相对 origin/main：ahead ${aheadMain} / behind ${behindMain}（阈值 ${maxBehindMain}）`;
  if (behindMain > maxBehindMain) {
    const message = `落后 origin/main ${behindMain} 个提交，超过阈值 ${maxBehindMain}`;
    if (aheadMain === 0) {
      failures.push(`${message}：git merge --ff-only origin/main 或重建分支`);
    } else {
      console.warn(
        `[freshness] 警告：${message}。这是特性/MR 分支（ahead ${aheadMain}），` +
          `分叉本身正常；若要跟主线对齐请先确认 MR 状态（冻结中的 Draft MR 不要盲目 rebase）。`,
      );
    }
  }
} catch {
  console.warn("[freshness] 仓库没有 origin/main，跳过 main 距离检查。");
}

if (failures.length > 0) {
  console.error(`[freshness] 基线过期，拒绝在旧架构上开工（当前分支：${branch}）：`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(
  `[freshness] 基线新鲜：${branch}${upstream ? `（与 ${upstream} 同步）` : ""}${
    mainReport ? `，${mainReport}` : ""
  }`,
);
