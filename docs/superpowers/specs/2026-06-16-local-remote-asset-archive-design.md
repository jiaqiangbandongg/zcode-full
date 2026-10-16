# Local Remote Asset Archive Design

## Background

Windows SSH users can fail during the default `local-download-upload` remote asset flow with:

```text
spawn C:\Windows\System32\tar.exe ENOENT
```

Logs show SSH authentication and remote environment detection succeed. The failure happens after the desktop host downloads a CDN component archive into the local `remote-assets-cache` and tries to extract it by spawning the Windows system tar binary.

## Goal

Remove the desktop client's dependency on a local system `tar` executable for remote asset cache extraction and local upload archive creation.

## Scope

- Applies to the desktop host local side of `local-download-upload`.
- Keeps `remote-download` behavior unchanged: remote servers still use their detected `tar` tool.
- Keeps the remote side of local upload unchanged: uploaded directory archives are still extracted on the remote host with remote `tar`.
- Does not change SSH protocol, remote target types, web remote control delivery semantics, or UI form behavior.

## Design

Add a small Node-based `.tar.gz` helper in `packages/server/src/remote`:

- `extractTarGzArchive(archivePath, targetDir)`
- `createTarGzArchive(archivePath, entries)`

The helper uses Node built-ins (`zlib`, `fs/promises`, `path`) and supports the archive shapes used by ZCode remote assets:

- regular files
- directories
- POSIX-style relative tar entry paths

The extractor rejects unsafe entries:

- absolute paths
- `..` traversal
- backslash paths
- symlinks and special device entries
- paths that resolve outside the target directory

## Integration Points

- `packages/server/src/remote/remoteAssetCache.ts`
  - Replace local `tar -xzf` extraction of downloaded CDN component archives with `extractTarGzArchive`.
- `packages/server/src/remote/remoteAssetInstaller.ts`
  - Replace local `tar -czf` creation for `LocalUploadAssetInstaller.installDirectory()` with `createTarGzArchive`.
- `packages/server/test/remoteDeploy.test.ts`
  - Use `createTarGzArchive` for test CDN fixture archives so tests no longer depend on local system tar.

## Compatibility

Existing cache layout and deployment behavior stay the same:

- component archives still extract into staging directories
- `.ready` markers and atomic commit behavior stay in existing callers
- local upload directory archives still preserve the top-level source directory name
- remote extraction command is unchanged

## Tests

- A regression test verifies `ensureRemoteReleaseDirFromCdn()` can download and extract component archives without spawning local `tar`.
- A safety test verifies path traversal tar entries are rejected.
- A local upload test verifies directory archive creation no longer spawns local `tar` and preserves the expected archive shape.

## Risks

- The Node tar helper intentionally supports a small tar subset. This is acceptable because remote asset build output is controlled by this project.
- If future assets require symlinks or special entries, this helper should be extended explicitly with tests instead of silently accepting them.
