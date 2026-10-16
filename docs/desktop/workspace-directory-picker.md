# Workspace Directory Picker

Desktop workspace opening uses Electron's native directory picker from the main process.

The picker is configured with `openDirectory` and `createDirectory` so users can select an existing workspace folder and, on platforms whose native dialog supports it, create a new folder before selecting it.

`createDirectory` is an Electron/macOS dialog capability. Windows and Linux behavior remains governed by the native system dialog and should not be treated as a guaranteed cross-platform folder creation flow.
