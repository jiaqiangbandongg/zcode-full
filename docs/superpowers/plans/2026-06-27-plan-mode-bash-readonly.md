# Bash Readonly Classification Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make ZCode Bash read-only permission classification conservative and keep it independent from cwd persistence.

**Architecture:** Keep using `unbash` for AST parsing, then apply a conservative safety layer over parsed simple commands, redirects, assignments, and argv. Bash read-only classification may grant plan-mode permission and concurrency safety, but it must not decide whether a successful Bash call persists cwd.

**Tech Stack:** TypeScript, Vitest, `unbash`, `@zcode/core` permission service, Bash tool handler.

## Global Constraints

- Use the readonly contract below as the baseline.
- Do not re-enable dedicated `Glob`/`Grep` tools to work around this bug.
- Do not loosen plan mode globally; only safe read/search/list Bash commands can become runtime read-only.
- Runtime read-only classification and cwd persistence are independent concerns.
- Main-thread foreground Bash persists successful in-workspace cwd and resets out-of-workspace cwd to the workspace root, matching the existing cwd policy.
- Subagent/non-main scope must not persist cwd.
- No automatic commit. The previous user instruction `不要自动提交` still applies.

## Readonly Contract

- Bash read-only classification parses the command, then runs a conservative read-only classifier over the AST.
- The classifier rejects too-complex AST, subshell/compound statements, unsafe bare assignments, unquoted variable expansion, unsafe UNC paths, unsafe redirects, unsafe env vars, and unsafe git/cd combinations before checking command names.
- Per-command argv checks strip safe wrappers such as `command`, `builtin`, and `noglob`.
- A command is read-only if every parsed simple command is safe by the direct argv policy or the command text regex/policy.
- Safe read/list/search commands include common tools such as `cat`, `head`, `tail`, `wc`, `stat`, `strings`, `file`, `grep`, `egrep`, `fgrep`, `rg`, `find`, `ls`, `tree`, `du`, `diff`, `pwd`, `whoami`, and trivial commands such as `echo`, `printf`, `true`, and `false`.
- `find` is safe only when write/execution options such as `-delete`, `-exec`, `-execdir`, `-ok`, `-okdir`, `-fprint`, `-fprint0`, `-fls`, `-fprintf`, and `-files0-from` are absent.
- Git read-only auto-allow is guarded: `cd/pushd/popd` combined with git requires permission checks rather than automatic read-only allow.
- Redirects are not all unsafe: input redirects and fd merges can be safe, `/dev/null` output is safe, but regular output redirects, `/dev/tcp`, `/dev/udp`, and Windows/UNC read redirects are unsafe.
- cwd persistence is controlled by the execution context (main thread vs. subagent scope); it is not derived from read-only classification.

## Tasks

### Task 1: Parser Surface

- [x] Extend `apps/zcode-cli/packages/core/src/tool/handlers/bash-command-parser.ts` so each `BashCommandInvocation` exposes normalized redirects and assignment names, not just boolean flags.
- [x] Keep dynamic word detection conservative for command substitution, process substitution, parameter expansion, arithmetic expansion, brace expansion, and extended glob.
- [x] Preserve parse-error and unsupported-node rejection.

### Task 2: Readonly Safety Policy

- [x] Update the Bash readonly policy with conservative command sets, safe flag tables, wrapper stripping, redirect validation, env assignment validation, and `find`/git guards.
- [x] Keep `apps/zcode-cli/packages/core/src/tool/handlers/bash-readonly-policy.ts` as the small public entrypoint.
- [x] Split policy internals by responsibility:
  - `bash-readonly-policy-types.ts`: shared policy types.
  - `bash-readonly-policy-flags.ts`: safe flag/value tables.
  - `bash-readonly-policy-callbacks.ts`: per-command dangerous-argument callbacks.
  - `bash-readonly-policy-commands.ts`: command policy maps and allowlists.
  - `bash-readonly-policy-argv.ts`: argv, redirect, env, wrapper, and git evaluation.
- [x] Keep all known write-capable patterns denied in plan mode.
- [x] Keep comments in Chinese where they explain bug-fix intent.

### Task 3: Runtime Semantics

- [x] Update `apps/zcode-cli/packages/core/src/tool/handlers/bash-semantics.ts` so `isRuntimeReadOnlyBashCommand()` checks all parsed simple commands using the readonly policy.
- [x] Make `isBashReadOnlyCommand()` and concurrency safety share the same safety contract.
- [x] Remove any cwd behavior that depends on read-only classification.

### Task 4: Handler Cwd Persistence

- [x] Update `apps/zcode-cli/packages/core/src/tool/handlers/bash.ts` so successful foreground main-thread Bash always calls `decideBashCwdPolicy(...)`, including commands that were classified as read-only.
- [x] Preserve existing subagent/non-main protection through `runtimeScope`.

### Task 5: Tests and Verification

- [x] Add failing tests in `apps/zcode-cli/packages/core/tests/bash-permission.test.ts` for safe read/search/list commands, safe redirects, wrapper stripping, denied dynamic/assignment/write cases, denied `cd && git`, and denied write redirects.
- [x] Add failing tests in `apps/zcode-cli/packages/core/tests/bash-handler.test.ts` proving read-only classification does not suppress main-thread cwd persistence.
- [x] Run focused Vitest files first.
- [x] Run `pnpm --filter @zcode/core typecheck`.
- [x] Run root `pnpm lint`; note unrelated failures if present.

## Verification Notes

- `pnpm --filter @zcode/core exec vitest run tests/bash-permission.test.ts tests/bash-handler.test.ts` passed.
- `pnpm --filter @zcode/core typecheck` passed.
- `oxfmt --check` on touched Bash files and this plan passed.
- `pnpm lint` passed with existing warnings only.
- `pnpm typecheck` still fails in `packages/desktop/test/e2e/reporting/e2e-ui-coverage.ts` because the existing Istanbul packages lack local declarations and several callback parameters are implicit `any`.
