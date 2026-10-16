# SSH Alias Workspace Title Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the SSH config alias in the task list workspace title as `<workspaceName> [SSH: <alias>]` for SSH remote workspaces opened through an alias.

**Architecture:** Treat the SSH alias as non-sensitive connection metadata. Carry it from the remote connection form into `RemoteTarget`, persist it in `RemoteTargetSnapshot`, hydrate it during reconnect, and format the sidebar label from the remote target without changing workspace identity or task realtime semantics.

**Tech Stack:** TypeScript, React, Zustand, Vitest, existing `RemoteTarget` / `RemoteWorkspaceSessionEntry` helpers.

---

### Task 1: Persist SSH Alias Metadata

**Files:**
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/shared/src/protocol.ts`
- Modify: `packages/shared/src/validation.ts`
- Modify: `packages/shared/src/validationAppSettings.ts`
- Modify: `packages/shared/test/validation.test.ts`
- Modify: `packages/ui/src/lib/remoteConnectionWizard.ts`
- Modify: `packages/ui/src/lib/remoteWorkspaceHistory.ts`
- Modify: `packages/ui/src/SSHDialog.tsx`
- Test: `packages/ui/test/remoteConnectionWizard.test.ts`
- Test: `packages/ui/test/remoteWorkspaceHistory.test.ts`

- [x] **Step 1: Write the failing target construction test**

Add this test to `packages/ui/test/remoteConnectionWizard.test.ts`:

```ts
it("includes the selected SSH config alias as target metadata", () => {
  const result = buildRemoteTarget(intl, {
    kind: "ssh",
    host: "localhost",
    port: "2223",
    username: "root",
    sshAuthMethod: "password",
    password: "secret",
    privateKeyPath: "",
    privateKeyPassphrase: "",
    selectedSshConfigAlias: " linux-arm64 ",
    wslDistro: "",
    dockerContainer: "",
  });

  expect(result.target).toMatchObject({
    kind: "ssh",
    sshConfigAlias: "linux-arm64",
  });
});
```

- [x] **Step 2: Write the failing snapshot persistence test**

Add this test to `packages/ui/test/remoteWorkspaceHistory.test.ts`:

```ts
it("persists and hydrates SSH config alias metadata", () => {
  const snapshot = createRemoteTargetSnapshot(
    "remote:ssh:localhost:2223:root:/root",
    {
      kind: "ssh",
      host: "localhost",
      port: 2223,
      username: "root",
      password: "secret",
      sshConfigAlias: "linux-arm64",
    },
  );

  expect(snapshot).toMatchObject({
    kind: "ssh",
    sshConfigAlias: "linux-arm64",
  });

  expect(
    createRemoteTargetFromSnapshot(snapshot, {
      password: "secret",
      privateKeyPassphrase: null,
    }),
  ).toMatchObject({
    kind: "ssh",
    sshConfigAlias: "linux-arm64",
  });
});
```

- [x] **Step 3: Run focused tests to verify red**

Run:

```bash
pnpm vitest run packages/ui/test/remoteConnectionWizard.test.ts packages/ui/test/remoteWorkspaceHistory.test.ts packages/ui/test/workspaceSidebarRemoteNotice.test.ts
```

Expected before implementation: FAIL with missing `sshConfigAlias` in the target and snapshot assertions.

- [x] **Step 4: Implement shared target and snapshot metadata**

Add optional `sshConfigAlias?: string` to:

```ts
export interface SSHConnectOptions {
  kind: "ssh";
  host: string;
  port?: number;
  username: string;
  sshConfigAlias?: string;
}
```

```ts
export interface SSHRemoteTargetSnapshot {
  kind: "ssh";
  host: string;
  port?: number;
  username: string;
  /** 用户建立连接时选择的 SSH config Host alias，仅用于 UI 展示。 */
  sshConfigAlias?: string;
}
```

Add `sshConfigAlias: nonEmptyStringSchema.optional()` to both SSH zod schemas in `packages/shared/src/validation.ts` and `packages/shared/src/validationAppSettings.ts`.

- [x] **Step 5: Implement target construction and snapshot plumbing**

In `packages/ui/src/lib/remoteConnectionWizard.ts`, add `selectedSshConfigAlias?: string | null` to `RemoteConnectionFormSnapshot` and emit the trimmed alias:

```ts
const sshConfigAlias = snapshot.selectedSshConfigAlias?.trim();

return {
  target: {
    kind: "ssh",
    host: snapshot.host,
    port: snapshot.port ? Number(snapshot.port) : undefined,
    username: snapshot.username,
    ...(sshConfigAlias ? { sshConfigAlias } : {}),
    assetInstallMode: snapshot.assetInstallMode,
  },
};
```

In `packages/ui/src/SSHDialog.tsx`, include `selectedSshConfigAlias` in the `buildRemoteTarget()` snapshot. In `packages/ui/src/lib/remoteWorkspaceHistory.ts`, persist and hydrate the alias:

```ts
...(target.sshConfigAlias?.trim()
  ? { sshConfigAlias: target.sshConfigAlias.trim() }
  : {}),
```

```ts
...(snapshot.sshConfigAlias ? { sshConfigAlias: snapshot.sshConfigAlias } : {}),
```

- [x] **Step 6: Run focused tests to verify green**

Run:

```bash
pnpm vitest run packages/ui/test/remoteConnectionWizard.test.ts packages/ui/test/remoteWorkspaceHistory.test.ts packages/shared/test/validation.test.ts
```

Expected after implementation: PASS.

### Task 2: Render Sidebar Alias Suffix

**Files:**
- Modify: `packages/ui/src/WorkspaceSidebarItem.tsx`
- Test: `packages/ui/test/workspaceSidebarRemoteNotice.test.ts`

- [x] **Step 1: Write the failing sidebar rendering test**

Add this test to `packages/ui/test/workspaceSidebarRemoteNotice.test.ts`:

```ts
it("SSH 远程工作区有配置别名时，在任务列表标题后展示 SSH 别名标签", () => {
  const html = renderWorkspaceItem({
    tab: createRemoteWorkspaceTab({
      label: "root",
      workspacePath: "/root",
      remoteTarget: {
        kind: "ssh",
        host: "localhost",
        port: 2223,
        username: "root",
        sshConfigAlias: "linux-arm64",
      },
      workspaceIdentity: "remote:ssh:localhost:2223:root:/root",
    }),
  });

  expect(html).toContain("root [SSH: linux-arm64]");
});
```

- [x] **Step 2: Run focused test to verify red**

Run:

```bash
pnpm vitest run packages/ui/test/workspaceSidebarRemoteNotice.test.ts
```

Expected before implementation: FAIL because the sidebar renders only `root`.

- [x] **Step 3: Implement minimal formatter**

Add this helper to `packages/ui/src/WorkspaceSidebarItem.tsx` and render `workspaceSidebarLabel` instead of `tab.label`:

```ts
function formatWorkspaceSidebarLabel(tab: WorkspaceTabState): string {
  if (tab.remoteTarget?.kind !== "ssh") {
    return tab.label;
  }

  const sshConfigAlias = tab.remoteTarget.sshConfigAlias?.trim();
  return sshConfigAlias ? `(${sshConfigAlias}) ${tab.label}` : tab.label;
}
```

- [x] **Step 4: Run focused test to verify green**

Run:

```bash
pnpm vitest run packages/ui/test/workspaceSidebarRemoteNotice.test.ts
```

Expected after implementation: PASS.

### Task 3: Verify Repository Constraints

**Files:**
- Modify: `docs/ui/ssh-config-alias.md`

- [x] **Step 1: Update the feature spec**

Document that SSH alias metadata is persisted as optional non-sensitive target metadata and rendered as `<workspaceName> [SSH: <alias>]` in the task list workspace title. State explicitly that alias does not participate in workspace identity.

- [x] **Step 2: Run focused regression tests**

Run:

```bash
pnpm vitest run packages/ui/test/remoteConnectionWizard.test.ts packages/ui/test/remoteWorkspaceHistory.test.ts packages/ui/test/workspaceSidebarRemoteNotice.test.ts packages/shared/test/validation.test.ts
```

Expected: PASS.

- [x] **Step 3: Run required typecheck**

Run:

```bash
pnpm typecheck
```

Expected: exit 0.

- [x] **Step 4: Run required lint**

Run:

```bash
pnpm lint
```

Expected: exit 0. Existing warnings outside this feature may still be reported by oxlint.

- [x] **Step 5: Inspect diff and commit**

Run:

```bash
git diff --check
git status --short
git add docs/ui/ssh-config-alias.md docs/superpowers/plans/2026-06-13-ssh-alias-workspace-title.md packages/shared/src/index.ts packages/shared/src/protocol.ts packages/shared/src/validation.ts packages/shared/src/validationAppSettings.ts packages/shared/test/validation.test.ts packages/ui/src/SSHDialog.tsx packages/ui/src/WorkspaceSidebarItem.tsx packages/ui/src/lib/remoteConnectionWizard.ts packages/ui/src/lib/remoteWorkspaceHistory.ts packages/ui/test/remoteConnectionWizard.test.ts packages/ui/test/remoteWorkspaceHistory.test.ts packages/ui/test/workspaceSidebarRemoteNotice.test.ts
git commit -m "feat(ui): show ssh alias in workspace task list"
```

Expected: no whitespace errors, only intended files staged, commit succeeds.
