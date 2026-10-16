# OpenTUI Node Runtime In SEA

## Goal

Replace the Ink-based `@zcode/tui` implementation with the Node.js runtime path of
OpenTUI while preserving zcode's release model: one SEA executable per supported
platform and architecture.

The first implementation milestone is intentionally small. The TUI package may
discard the current Ink implementation and expose a basic OpenTUI shell through
the existing `runTui(options)` API. Business workflows, session state, command
handling, and permission behavior remain owned by the CLI/core packages and will
be wired back into the new renderer incrementally.

## Runtime Shape

The OpenTUI dependency baseline is the local Node-compatible fork published under
the `@mbears/opentui-core` and `@mbears/opentui-react` package names. Local development can
wire these packages through `file:` dependencies or pnpm overrides that point at
`../opentui-node/packages/*/dist`; release packaging should consume the same
package names from the intended source. It keeps ZCode on the existing Node.js
24.14.x production baseline by using the OpenTUI Node FFI path backed by
`koffi`, `unsafe-pointer`, and the platform `libopentui` native package. Later
OpenTUI work that depends on Node's experimental `node:ffi` is not a runtime
baseline for this migration.

The CLI SEA entry remains CommonJS. zcode currently targets Node.js 24.14.0, and
that version executes the injected SEA main script as CommonJS. OpenTUI and
`@zcode/tui` remain ESM packages, so the CJS entry must load them with dynamic
`import()`.

There are two load paths:

- Normal development/install path: dynamically import `@zcode/tui` through Node's
  package resolver.
- SEA path: extract embedded TUI runtime assets into a stable user cache
  directory, then dynamically import the extracted `@zcode/tui` entry by
  `file://` URL.

OpenTUI native artifacts must exist as real files. They are not spawned helper
programs; they are native libraries loaded by the Node/OpenTUI runtime. The SEA
binary therefore embeds them as assets and writes them to the cache before the
TUI package is imported.

## Assets

Each SEA target embeds a target-specific runtime bundle:

- `@zcode/tui/dist`
- `@zcode/tui/package.json`
- Runtime workspace dependencies declared by `@zcode/tui`, currently
  `@zcode/i18n` and `@zcode/contracts`, including each package's `dist` and
  `package.json`
- `@mbears/opentui-core`
- `@mbears/opentui-react`
- The matching `@mbears/opentui-core-<platform>-<arch>` native package
- OpenTUI Node FFI dependencies such as `koffi`, `unsafe-pointer`, and their
  target-specific `.node` files
- React renderer dependencies such as `react`, `react-reconciler`, and
  `scheduler`
- OpenTUI core runtime dependencies such as `yoga-layout`

The runtime bundle is stored under a single SEA asset prefix and extracted to a
node_modules-shaped directory. The extracted layout should look like a normal
package install rather than a temporary pile of random files.

Workspace runtime packages must be discovered from the workspace package
manifests and traversed with the same dependency closure as third-party runtime
packages. The collector must not maintain a partial `@zcode/*` allowlist: adding
a workspace package to `dependencies` means its built package surface is part of
the SEA runtime. Type-only or build-only workspace packages belong in
`devDependencies` so they do not inflate the extracted runtime.

The package bundle must be validated with the repository's Node 24 runtime.
OpenTUI branches that require Node 26 or `node:ffi` are out of scope unless
they regain a Node 24-compatible FFI backend.

## Cache

The extractor writes to a per-user cache directory:

- macOS: `~/Library/Caches/zcode/sea-assets`
- Linux: `$XDG_CACHE_HOME/zcode/sea-assets` or `~/.cache/zcode/sea-assets`
- Windows: `%LOCALAPPDATA%/zcode/Cache/sea-assets`

The full directory includes zcode version, target key, and manifest hash:

```text
<cache>/sea-assets/<version>/<target>/<hash>/
  manifest.json
  node_modules/
    @zcode/tui/
    @mbears/opentui-core/
    @mbears/opentui-react/
    @mbears/opentui-core-darwin-arm64/
    ...
```

Extraction is idempotent. A complete manifest with the expected hash allows the
next run to reuse the cache. If the manifest is missing or stale, the extractor
rebuilds a temporary directory and atomically swaps it into place.

Unix file modes are normalized while extracting:

- Directories: `0755`
- JavaScript, JSON, declarations, wasm, and text assets: `0644`
- Native libraries and `.node` files: `0755`

The cache must not default to `/tmp`, because some Linux systems mount it with
`noexec`, which can break dynamic library loading.

## Cross Target Packaging

zcode continues to publish one binary per target:

- `darwin-arm64`
- `darwin-x64`
- `linux-arm64`
- `linux-x64`
- `win-arm64`
- `win-x64`

The SEA build generates a target-specific blob because the native OpenTUI package
differs by target. The workspace installs all optional OpenTUI native packages by
using pnpm `supportedArchitectures`, so the build can collect native packages for
targets other than the current host.

If a target native package is missing, the SEA build fails before injection with
a message that names the missing package and suggests running `pnpm install`.

## Milestones

1. Replace `@zcode/tui` with a small OpenTUI shell that keeps the public TypeScript
   API stable.
2. Add a CLI loader that chooses between normal package import and SEA extracted
   import.
3. Add SEA asset collection and runtime extraction for the TUI runtime.
4. Prove the host SEA binary can run `zcode tui` from a clean directory without
   access to the repo `node_modules`.
5. Expand validation for every supported release target in CI or on matching
   machines.

## Regression Coverage

- The SEA asset manifest must contain `package.json` and `dist/index.js` for
  `@zcode/tui`, `@zcode/i18n`, and `@zcode/contracts`.
- Workspace source files must not be copied into the runtime bundle.
- The Linux x64 manifest case represents the platform-independent workspace
  dependency closure; target-specific tests continue to cover native OpenTUI
  package selection for all supported targets.
- A host-target extraction test must materialize only the collected SEA assets
  into an isolated directory and successfully import `@zcode/tui` from that
  directory, without falling back to repository `node_modules`.
