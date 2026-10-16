# Workspace Open Actions

## Current Behavior

- The app no longer has a standalone `OpenWorkspacePage`.
- Startup restores persisted workspace tabs when available.
- If startup finishes with no workspace, `Root` creates the default workspace and opens it.
- `File > Open Workspace`, `Cmd/Ctrl+O`, and the sidebar open-workspace entry execute the root-level open action directly.
- Web/server roots may opt into the service-backed directory browser via `preferDirectoryBrowser`.

```text
Open workspace action
  |-- allowOpenWorkspace=false -> ignore (Web remote control attach-only boundary)
  |-- preferDirectoryBrowser=true -> DirectoryBrowser -> fileService.readdir on target host
  |-- desktop/native picker available -> platform.selectDirectory()
  `-- picker unavailable -> default workspace fallback
```

## Boundaries

- Desktop local windows use the platform directory picker when settings and platform selection are available.
- Web/server roots use `DirectoryBrowser` when `preferDirectoryBrowser=true`, so the chosen path belongs to the connected target host rather than the browser machine.
- Shells without a directory picker fall back to the default workspace instead of entering a directory-selection page.
- Web remote control keeps `allowOpenWorkspace=false`, so mobile remote control continues attaching to the desktop-owned Local/Remote Host that already owns the target workspace scope and does not create independent Host or Agent runtimes.
