#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

import { selectDefaultBranchRef } from "./affected-unit-test-baseline.mjs";

const CODE_EXTENSIONS = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".json",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);
const CHANGED_DIFF_FILTER = "ACMRTUXB";
const ZERO_SHA = /^0{40}$/u;

function resolvePnpmCliPath(env) {
  const npmExecPath = env.npm_execpath;
  if (
    npmExecPath &&
    (npmExecPath.toLowerCase().includes("\\pnpm\\") ||
      npmExecPath.toLowerCase().includes("/pnpm/"))
  ) {
    return npmExecPath;
  }

  const pathEntries = (env.PATH ?? env.Path ?? "")
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  for (const pathEntry of pathEntries) {
    const candidate = join(pathEntry, "node_modules", "pnpm", "bin", "pnpm.cjs");
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

function run(command, args, options = {}) {
  const spawnOptions = {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env,
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
  };

  if (process.platform === "win32" && command === "pnpm") {
    // Bugfix: Windows pre-push runner 需要保持 lint-staged 传入的文件 argv 原样。
    // 只在本脚本内绕过 cmd shim，避免影响 bootstrap/build 共享命令入口。
    const cliPath = resolvePnpmCliPath(options.env ?? process.env);
    if (cliPath) {
      return spawnSync(process.execPath, [cliPath, ...args], spawnOptions);
    }
    return spawnSync("pnpm", args, { ...spawnOptions, shell: true });
  }

  return spawnSync(command, args, spawnOptions);
}

function runGit(args, options = {}) {
  const result = run("git", args, options);
  if (result.status !== 0 && options.required !== false) {
    const detail = result.stderr?.trim() || result.stdout?.trim();
    throw new Error(`git ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
  return result.status === 0 ? result.stdout.trim() : "";
}

function print(message) {
  console.log(`[pre-push affected tests] ${message}`);
}

function hasCommit(root, ref) {
  if (!ref) {
    return false;
  }
  const result = runGit(["rev-parse", "--verify", `${ref}^{commit}`], {
    cwd: root,
    required: false,
  });
  return Boolean(result);
}

function isZeroSha(value) {
  return ZERO_SHA.test(value);
}

function parsePrePushInput(value) {
  return value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [localRef, localSha, remoteRef, remoteSha] = line.split(/\s+/u);
      if (!localRef || !localSha || !remoteRef || !remoteSha) {
        return undefined;
      }
      return { localRef, localSha, remoteRef, remoteSha };
    })
    .filter(Boolean);
}

function resolveDefaultBranchBase(root) {
  const originHead = runGit(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], {
    cwd: root,
    required: false,
  });

  const ref = selectDefaultBranchRef({
    originHead,
    hasCommit: (candidate) => hasCommit(root, candidate),
  });

  if (!ref) {
    return undefined;
  }

  return {
    base: ref,
    head: "HEAD",
    label: `default branch ${ref}`,
    useMergeBase: true,
  };
}

function resolvePrePushTarget(root) {
  const entries = parsePrePushInput(process.env.ZCODE_PRE_PUSH_STDIN ?? "");
  if (entries.length === 0) {
    return undefined;
  }

  const headSha = runGit(["rev-parse", "HEAD"], { cwd: root });
  const currentRef = runGit(["symbolic-ref", "--quiet", "HEAD"], {
    cwd: root,
    required: false,
  });
  const candidate =
    entries.find((entry) => entry.localSha === headSha && !isZeroSha(entry.localSha)) ??
    entries.find((entry) => entry.localRef === currentRef && !isZeroSha(entry.localSha)) ??
    entries.find((entry) => !isZeroSha(entry.localSha));

  if (!candidate) {
    return undefined;
  }

  if (isZeroSha(candidate.remoteSha)) {
    print(`${candidate.remoteRef} 是新建远端分支，pre-push stdin 没有可比较的 remote sha。`);
    return undefined;
  }

  if (!hasCommit(root, candidate.remoteSha) || !hasCommit(root, candidate.localSha)) {
    return undefined;
  }

  return {
    base: candidate.remoteSha,
    head: candidate.localSha,
    label: `pre-push remote ${candidate.remoteRef}`,
    useMergeBase: false,
  };
}

function resolveUpstreamTarget(root) {
  const upstream = runGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], {
    cwd: root,
    required: false,
  });

  if (!hasCommit(root, upstream)) {
    return undefined;
  }

  return {
    base: upstream,
    head: "HEAD",
    label: `upstream ${upstream}`,
    useMergeBase: false,
  };
}

function resolveDiffTarget(root) {
  const explicitBase =
    process.env.ZCODE_PRE_PUSH_BASE?.trim() || process.env.ZCODE_AFFECTED_TEST_BASE?.trim();
  if (explicitBase) {
    if (!hasCommit(root, explicitBase)) {
      throw new Error(`显式 base 不存在或不是 commit: ${explicitBase}`);
    }
    return {
      base: explicitBase,
      head: "HEAD",
      label: `explicit base ${explicitBase}`,
      useMergeBase: true,
    };
  }

  return (
    resolvePrePushTarget(root) ?? resolveUpstreamTarget(root) ?? resolveDefaultBranchBase(root)
  );
}

function extensionOf(file) {
  const match = file.match(/(\.[^./]+)$/u);
  return match?.[1] ?? "";
}

function isRootUnitTestFile(file) {
  return (
    /^packages\/[^/]+\/test\/.*\.test\.ts$/u.test(file) &&
    !file.startsWith("packages/desktop/test/e2e/")
  );
}

function isCodeLikeFile(file) {
  return CODE_EXTENSIONS.has(extensionOf(file));
}

function isRootVitestScope(file) {
  return file.startsWith("packages/") && !file.startsWith("packages/desktop/test/e2e/");
}

function collectPaths(value) {
  return value.split("\0").filter(Boolean);
}

function runFullUnitTests(root, reason) {
  print(`${reason}，执行全量 pnpm run test:unit。`);
  return (
    run("pnpm", ["run", "test:unit"], {
      cwd: root,
      stdio: "inherit",
    }).status ?? 1
  );
}

function runLintStaged(root, base, head) {
  const diffRange = `${base}..${head}`;
  print(`执行 pnpm exec lint-staged --diff ${diffRange}`);

  // lint-staged 面向 pre-commit 设计，会在任务结束后自动 git add 匹配文件。
  // pre-push 只应验证，不应改动真实 index；因此让 lint-staged 在临时 index 上完成内部流程。
  const tempIndexDir = mkdtempSync(join(tmpdir(), "zcode-lint-staged-index-"));
  const tempIndexFile = join(tempIndexDir, "index");

  try {
    return (
      run(
        "pnpm",
        [
          "exec",
          "lint-staged",
          "--relative",
          "--concurrent",
          "false",
          "--diff",
          diffRange,
          "--diff-filter",
          CHANGED_DIFF_FILTER,
          "--config",
          "lint-staged.config.mjs",
        ],
        {
          cwd: root,
          env: {
            ...process.env,
            GIT_INDEX_FILE: tempIndexFile,
          },
          stdio: "inherit",
        },
      ).status ?? 1
    );
  } finally {
    rmSync(tempIndexDir, { force: true, recursive: true });
  }
}

function main() {
  const root = runGit(["rev-parse", "--show-toplevel"], {
    cwd: process.cwd(),
  });

  const target = resolveDiffTarget(root);
  if (!target) {
    return runFullUnitTests(root, "未找到可用于比较的 upstream 或默认 base");
  }

  const comparisonBase = target.useMergeBase
    ? runGit(["merge-base", target.base, target.head], { cwd: root })
    : target.base;
  print(`使用 ${target.label} 计算 affected 范围：${comparisonBase}..${target.head}`);

  const changedFiles = collectPaths(
    runGit(
      [
        "diff",
        "--name-only",
        "-z",
        `--diff-filter=${CHANGED_DIFF_FILTER}`,
        comparisonBase,
        target.head,
      ],
      { cwd: root },
    ),
  );
  const deletedFiles = collectPaths(
    runGit(["diff", "--name-only", "-z", "--diff-filter=D", comparisonBase, target.head], {
      cwd: root,
    }),
  );

  if (changedFiles.length === 0 && deletedFiles.length === 0) {
    print(`当前 ${target.head} 相对 ${comparisonBase} 没有变更，跳过 Vitest 单测。`);
    return 0;
  }

  const deletedCodeFile = deletedFiles.find(
    (file) => isRootVitestScope(file) && isCodeLikeFile(file),
  );
  if (deletedCodeFile) {
    return runFullUnitTests(root, `${deletedCodeFile} 已删除，无法交给 vitest related 分析`);
  }

  const existingFiles = changedFiles.filter((file) => existsSync(resolve(root, file)));
  const testFiles = existingFiles.filter(isRootUnitTestFile);
  const relatedSourceFiles = existingFiles.filter(
    (file) => isRootVitestScope(file) && isCodeLikeFile(file) && !isRootUnitTestFile(file),
  );

  if (testFiles.length === 0 && relatedSourceFiles.length === 0) {
    print("没有影响根 Vitest 单测范围的 JS/TS/JSON 文件，跳过 Vitest 单测。");
    return 0;
  }

  return runLintStaged(root, comparisonBase, target.head);
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(
    `[pre-push affected tests] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
