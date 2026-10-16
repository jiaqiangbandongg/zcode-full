# CI Feishu Card 2.0 Notification Implementation Plan

> **For Agent:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the CI build artifact Feishu template message with a self-built Card 2.0 while preserving triggers, fields, and non-blocking failure behavior.

**Architecture:** Keep `notify-feishu-ci.mjs` as the CI adapter and move only message construction in `notify-feishu.mjs` from template payload to Card 2.0 JSON. Production receiver configuration remains in GitLab variables; tests use the temporary receiver `oc_5725795450da6920872fdb25412848bf`.

**Tech Stack:** Node.js ESM, native `fetch`, Vitest, Feishu Card JSON 2.0.

---

### Task 1: Lock the notification contract

**Files:** `docs/ci-feishu-card2-notification.md`

Document the unchanged trigger, fields, receiver boundary, Card 2.0 shape, size/escaping expectations, and non-blocking CI failure behavior.

### Task 2: Add failing Card 2.0 tests

**Files:** `packages/desktop/test/notifyFeishuScript.test.ts`

Assert the exported card builder produces `schema: "2.0"`, retains all existing fields, uses the expected visual structure, and serializes user-controlled commit text safely. Assert the message payload uses interactive Card 2.0 content and the test receiver constant in test fixtures.

### Task 3: Implement the Card 2.0 builder

**Files:** `scripts/notify-feishu.mjs`

Add pure builders for the header, metadata blocks, artifact link, and commit section. Replace the template envelope with `content: JSON.stringify(card)`, keep the same Feishu endpoint and token flow, and reject oversized serialized cards before sending.

### Task 4: Verify and update CI documentation

**Files:** `docs/desktop-ci-cd.md`

Describe the new Card 2.0 payload and preserve the existing environment variable and failure semantics. Run the focused unit test, typecheck, and lint.

### Task 5: Commit

Commit the implementation and documentation with Conventional Commits, for example `feat(ci): send build notifications as feishu card 2.0`.
