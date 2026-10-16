# Windows Remote Asset Cache Rename Hardening

## Background

Windows users can fail to connect to WSL after remote asset artifacts have already been downloaded and extracted locally:

```text
EPERM: operation not permitted, rename
C:\Users\<user>\AppData\Roaming\ZCode\remote-assets-cache\staging\remote-release-component-glm-linux-x64-...\component
->
C:\Users\<user>\AppData\Roaming\ZCode\remote-assets-cache\releases\3.1.2\linux-x64\glm\linux-x64
```

Running ZCode as administrator does not reliably fix this failure.

## Root Cause

The failure happens on the desktop host side while committing a staged component directory into the local `remote-assets-cache`. The previous implementation used bare directory `rename` calls for both target backup and staged directory commit.

On Windows, directory rename can temporarily fail with `EPERM`, `EBUSY`, `EACCES`, or `ENOTEMPTY` when antivirus, file indexing, or another recently exited host process still holds a handle inside the directory. Elevation changes ACL checks, but it does not release these external file handles.

## Fix

`packages/server/src/remote/remoteAssetCache.ts` now wraps remote asset cache directory commits in bounded retry with backoff. Backup cleanup is best-effort after a successful commit so a temporary inability to delete an obsolete backup directory does not block an otherwise usable WSL connection.

The cache layout, CDN manifest flow, WSL deployment protocol, desktop continuous session flow, and mobile replayable remote-control flow are unchanged.

## Verification

- `pnpm vitest run packages/server/test/remoteDeploy.test.ts packages/server/test/remoteAssetInstaller.test.ts`
- `pnpm typecheck`
- `pnpm lint`
