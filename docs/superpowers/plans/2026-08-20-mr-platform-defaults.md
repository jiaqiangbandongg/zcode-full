# MR Platform Defaults Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make merge-request pipelines default to macOS ARM64 and Windows x64 while preserving all-platform defaults for manually created pipelines.

**Architecture:** Keep platform selection centralized in the existing `ZCODE_BUILD_PLATFORMS` rules. Add the MR-specific default at the workflow boundary so both MR environment branches produce the same job graph, without changing web, API, trigger, tag, `ci/*`, or sandbox behavior.

**Tech Stack:** GitLab CI YAML, Vitest text-contract tests, pnpm.

---

### Task 1: Lock the MR workflow contract

**Files:**
- Modify: `packages/desktop/test/ciNodeVersionConfig.test.ts`
- Modify: `.gitlab/ci/00-workflow.yml`
- Verify: `docs/ci-build-platform-selection.md`

- [x] **Step 1: Write the failing test**

Add a test that reads both MR workflow rule blocks and asserts each contains:

```ts
expect(ruleBlock).toContain('ZCODE_BUILD_PLATFORMS: "macos-arm64,windows-x64"');
```

Also assert the manual test and production workflow rule blocks do not define `ZCODE_BUILD_PLATFORMS`, preserving the empty-variable all-platform default for `web`, `api`, and `trigger` sources.

- [x] **Step 2: Run the focused test to verify RED**

Run:

```bash
pnpm exec vitest run packages/desktop/test/ciNodeVersionConfig.test.ts
```

Expected: FAIL because the MR workflow rules do not yet inject `ZCODE_BUILD_PLATFORMS`.

- [x] **Step 3: Implement the minimal workflow change**

Add the following variable to both MR workflow `variables` blocks in `.gitlab/ci/00-workflow.yml`:

```yaml
ZCODE_BUILD_PLATFORMS: "macos-arm64,windows-x64"
```

Do not add the variable to web, Pipeline API, or Trigger API workflow rules.

- [x] **Step 4: Run focused and CI configuration verification**

Run:

```bash
pnpm exec vitest run packages/desktop/test/gitlabCiBuildGraph.test.ts packages/desktop/test/ciNodeVersionConfig.test.ts
node scripts/ci/ci-lint-pipeline.mjs
pnpm lint
pnpm typecheck
```

Expected: focused tests, CI lint, and lint pass. Typecheck must be executed; unrelated repository baseline failures are reported separately.

- [x] **Step 5: Commit and push**

```bash
git add .gitlab/ci/00-workflow.yml packages/desktop/test/ciNodeVersionConfig.test.ts docs/superpowers/plans/2026-08-20-mr-platform-defaults.md
git commit -m "fix(ci): default MR builds to selected platforms"
git push origin chore/build-for-sp-platform
```
