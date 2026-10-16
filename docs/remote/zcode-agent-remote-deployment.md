# ZCode Agent Remote Deployment

## Scope

For Desktop-attached SSH/Docker/WSL workspaces, Desktop Main starts or reuses a local Electron
Remote Host utility process. That Remote Host connects to `zcode-server` and the ZCode Agent runtime
on the remote machine, where file, git, terminal, and agent execution observe the remote filesystem
and process environment. The window-scoped Local Host remains a separate process; a remote workspace
does not replace it or receive a second Local Host.

Current remote deployment only prepares the default ZCode resource set:

- `server-bundle`
- `node-runtime`
- `node-pty`
- `glm` / ZCode Agent runtime
- `bfs`
- `ripgrep`
- `ugrep`

Retired third-party agent and proxy runtimes are not deployed.

## Runtime Layout

Remote server base path:

```text
~/.zcode/server/
├── node
├── zcode-server.cjs
├── build/Release/pty.node
├── agents/glm/
│   ├── .version
│   ├── zcode.cjs
│   └── zcode-agent
├── .asset-components/
│   ├── server-bundle.json
│   └── glm.json
└── tools/
    ├── bfs/
    │   ├── .version
    │   └── bfs
    ├── ripgrep/
    │   ├── .version
    │   └── rg
    └── ugrep/
        ├── .version
        └── ugrep
```

Linux SSH、Docker 与 WSL 部署 `bfs 4.1.1-2`、`ugrep 7.8.4-1` 和 Microsoft
`ripgrep 14.1.1-1` component。Darwin remote 继续只部署历史 `ripgrep 13.0.0-10`
component；remote producer 按目标平台选择依赖链，不能删除历史 rg13 release 资产。

`deployZCodeAgentRuntime()` treats the `glm` manifest artifact SHA-256 as the
production deployment identity while the desktop App version is unchanged. It
skips deployment only when `.asset-components/glm.json` records the same SHA and
platform and the wrapper, bundle, and official plugin assets still exist. The
GLM semantic runtime version does not participate in this decision: the same
version with new artifact bytes must be deployed, while a version-label change
with identical artifact SHA does not trigger deployment by itself. A legacy
marker without SHA is migrated by one deployment that writes the current SHA.

When the installed remote server reports an App version different from the
current desktop App, the desktop must force-refresh `glm` after updating the
server. The marker is not trustworthy across App versions because an older App
can overwrite `agents/glm` through its legacy deployment path without updating
the newer `.asset-components/glm.json` marker. Both local-upload and
remote-download modes therefore bypass the SHA skip decision and their existing
component cache, then fetch the artifact selected by the current App manifest
again. A forced refresh is scoped to one component per deployment: the GLM
bundle and official plugin installation must reuse the same freshly downloaded
component, rather than deleting and downloading that component once for each
mounted path. In local-upload mode, that single fresh component is uploaded to
replace both the remote bundle and official plugin directory.

The App-version refresh is retry-safe. Before replacing the remote server, the
desktop replaces the existing GLM live marker with a persistent
`pendingRefreshAppVersion` marker. If server replacement or any later
node-pty/GLM download, upload, plugin replacement, or wrapper installation fails,
the next connection still observes that pending marker after the server version
has already advanced. It must continue bypassing the same-SHA component cache
until GLM deployment succeeds and overwrites the pending marker with the current
artifact SHA. The already completed forced `server-bundle` installation remains
valid across that retry.

```text
remote App version differs
        |
        v
write glm.pendingRefreshAppVersion
        |
        v
force-refresh server-bundle --> deploy node-pty --> force-refresh GLM
        |                            |                    |
        +------------ failure -------+--------------------+
        |                                                 |
        v                                                 v
keep pending marker                              write GLM SHA marker
        |                                                 |
        v                                                 v
next connection forces GLM again                    pending cleared
```

Each deployment pins one fresh manifest snapshot: the SHA used for the skip
decision, the component artifact materialized locally, and the SHA written to
the remote marker all come from that same snapshot. Concurrent local release
assembly is isolated by GLM SHA, so sessions observing different republished
artifacts cannot reuse each other's release directory. The pinned snapshot also
retains the CDN origin that supplied the manifest, so component downloads prefer
that same origin before falling back to other candidates.

Every manifest candidate request has a finite application-level timeout
(10 seconds by default) that
covers both response headers and the response body. A timed-out candidate is
aborted before the next CDN candidate is attempted. If no candidate completes,
the fresh identity lookup records an observable warning and aborts that
deployment. It must not continue through an installer request that could observe
a different manifest snapshot. This keeps remote initialization and later
connection attempts from sharing a permanently pending manifest request.

`server-bundle` also uses the manifest artifact SHA-256 as its production
deployment identity. The App must compare `.asset-components/server-bundle.json`
with the fresh manifest before deciding that an equal App version can skip the
server upload. A missing legacy marker or a different SHA triggers one server
deployment and writes the current SHA only after installation succeeds. This
allows a server bundle to be republished under the same App/component semantic
version without reusing the previous bytes.

When the installed remote server reports an App version different from the
current desktop App, `server-bundle` follows the same forced-refresh boundary as
`glm`: both local-upload and remote-download modes must bypass an existing
same-SHA component cache, download and verify the artifact selected by the
current App manifest again, and deploy that freshly materialized component.
The App-version boundary therefore never trusts a historical `.ready` cache
marker for either component. Equal App versions continue to use SHA-addressed
caches and only redeploy when the fresh manifest SHA differs from the live
marker or required runtime files are missing.

The fresh manifest used by the server skip decision must be the same pinned
snapshot used to resolve and install `server-bundle`. In both local-download-
upload and remote-download modes, the server component cache key is the manifest
SHA rather than the semantic component version. Legacy semantic-version cache
directories must not be migrated into a SHA-keyed server cache because their
contents cannot prove the requested artifact identity. `node-runtime`,
`node-pty`, and `ripgrep` keep their existing deployment and component-cache
decisions. Development-mode local bundles continue to use the separate
`.dev-version` content hash flow.

```text
remote App version vs current App version
        |
        +-- different ----------------> force refresh current server-bundle + GLM artifacts
        |                               deploy server + bundle + plugins + wrapper
        |                               then write current sha256 markers
        |
        +-- equal --------------------> compare GLM manifest sha256
                                                |
                                                v
                               remote .asset-components/glm.json
                                                |
                                                +-- equal + files complete --> skip
                                                |
                                                +-- missing/different --------> deploy
                                                                                then write sha256
```

```text
fresh manifest server-bundle.sha256
                 |
                 v
remote .asset-components/server-bundle.json
                 |
                 +-- equal + version/markers complete --> skip server
                 |
                 +-- missing/different ----------------> SHA-keyed cache
                                                         download + verify
                                                         install server
                                                         write current sha256
```

## Service Registration

The renderer-facing host collection is mixed:

- Remote proxy: file, git, system, terminal, file watcher, ZCode task/session/agent services,
  workspace-scoped Provider Settings, and workspace-scoped Model Selection.
- Local implementation: Desktop app-global settings, OAuth UI integration, usage/coding-plan
  presentation, and other window-global state.

This keeps workspace and model-execution facts in the target Environment while retaining Desktop
app-global UI state locally. The mixed collection must not be interpreted as one process owning all
facts: remote runtime Provider Settings and Model Selection are always forwarded from the target
Environment. The Desktop Settings page is an app-global local editor and intentionally does not use
the remote Provider Settings facade.

## Provider Runtime Ownership

Each remote Environment owns its Provider Config, Credential Store, Registry, and ModelFactory. Its
Host and Core Worker independently construct Registry instances from that Environment's sources;
they do not consume a materialized Desktop Registry snapshot.

```text
Desktop Entry
    |
    | remote Provider Settings / Model Selection / task commands
    v
Remote Environment
├─ ZCode Built-in + Personal + Account Provider Config
├─ Credential Store
├─ Host Registry
└─ Core Worker Registry -> ModelFactory -> model request
```

The remote Host may send its own no-secret Account Provider Config Overlay to its own Core Worker via
`provider/updateAccountConfig`. This is an intra-Environment process boundary, not a Desktop-to-remote
configuration sync. API keys, JWTs, Team runtime keys, and dynamic headers are not part of that
Overlay.

The retired `workspace/updateProviderRegistry` protocol must remain unavailable. Desktop does not
inject a complete Registry, Runtime Model, Account Overlay, or request credential into a remote
Worker. A remote runtime that is not ready waits for its own Provider Runtime startup; it is not
bootstrapped from Desktop state.

Configuration or credential synchronization is a separate provisioning feature. The current
Environment-level automatic Local → Remote flow is specified in `docs/remote/provider-provisioning.md`;
it writes the target Environment's Config/Credential stores and lets that Environment rebuild its
Registry. Desktop Main only coordinates Environment identity and generations; it never carries Config
or Secret. This flow must not revive runtime Registry injection.

This ownership boundary does not change desktop `continuous` or mobile Web `replayable` task delivery
semantics. Workspace identity isolation continues to use
`workspaceIdentity?.trim() || workspacePath`; filesystem operations continue to use `workspacePath`.

## Deployment Modes

Desktop can either download component artifacts locally and upload them over SSH, or ask the remote server to download from CDN.

Remote deployment commands require a POSIX `sh`; they must not assume that
`bash` is installed. This keeps Docker/SSH targets based on Alpine or BusyBox
supported. The deploy lock holder is written to a temporary remote script and
executed by `sh`, while the existing caller-serialized Desktop SSH path still
skips the remote lock as documented below.

In local-download-upload mode, Docker files are written through the container's
current user (`docker exec` + stdin) rather than `docker cp`. This preserves the
owner needed by later `chmod`/replace commands when the container runs as a
non-root user. Failed non-cancelled file replacements must remove only their
own temporary `.new-*` path; cancellation must not reuse a released backend.

Remote asset build preparation must provide a SHA-256 for every prebuilt archive,
including the legacy Darwin ripgrep release. A missing digest is a preparation
error and must fail before any network download.

### Desktop-side network policy

All HTTP(S) requests issued by the Desktop Window Host while resolving remote
assets must use the same immutable Host network transport as app-managed API
requests. This includes fresh manifest reads, component archive downloads, and
the optional `HEAD` request used to estimate remote-download progress.

- `AppSettings.httpProxy`, `httpProxyNoProxy`, and `httpProxyCaCertPath` remain
  the only Desktop authority for this transport. Ambient shell proxy and CA
  variables are not an implicit source.
- An explicit proxy or CA failure is fail-closed for mandatory manifest and
  component requests; they must not retry through `globalThis.fetch`. The
  optional remote-download progress `HEAD` keeps its existing best-effort
  failure behavior, but it must not fall back to a direct request.
- Remote-asset requests reuse the lifecycle snapshot and dispatcher pool owned
  by the Window Host's base local service collection. They must not create an
  additional download-specific proxy-policy source or dispatcher pool; the
  existing desktop-attached remote service collections keep their own API
  transport ownership unchanged.
- Standalone server callers that do not receive the Desktop-owned transport keep
  their existing direct behavior.
- In `remote-download` mode only the Desktop-side manifest and progress metadata
  requests use this policy. The component archive itself is still downloaded by
  the remote machine's `curl` or `wget` and therefore follows the remote
  machine's network configuration.

```text
setting.json
  httpProxy / noProxy / CA
            |
            v
Window Host base-service network transport (lifecycle snapshot)
       |                         |
       v                         v
NodeApiClient             RemoteAssetNetworkPort
                              |        |
                              v        v
                         manifest   archive / HEAD
                              |
                              v
                    local cache -> SSH upload
```

## Deployment Serialization

Desktop SSH workspaces reuse one shared SSH host per window and SSH target. The
shared host readiness promise serializes initial connection and deployment, so
the `InitRemoteSshHost` path must declare caller-side serialization and skip the
remote install-root deploy lock. This avoids keeping a dedicated SSH lock-holder
channel alive after deployment. Dedicated SSH runtime paths do not share this
readiness boundary and continue to use the remote lock.

This exception accepts the product constraint that the desktop has one window
and that multiple clients do not deploy to the same SSH install root. It also
accepts the residual risk that a remote command from a disconnected SSH
deployment could briefly overlap the next reconnect.

WSL and Docker deployment continue to use the remote install-root lock. Callers
that do not explicitly declare caller-side serialization also default to the
remote lock, including the standalone Web server connection API.

```text
Desktop SSH target
        |
        v
window-scoped shared SSH host readiness
        |
        v
single deployServer transaction ----------> no remote deploy lock

WSL / Docker / unspecified caller
        |
        v
remote install-root deploy lock ----------> deployServer transaction
```

Local-download-upload mode uses the desktop host's Node runtime to create and extract local `.tar.gz` archives. It must not depend on a local system `tar` binary, because Windows clients may not expose `C:\Windows\System32\tar.exe` to the Electron host process.

Remote-server download mode requires:

- `curl` or `wget`
- `tar`
- `sha256sum`, `shasum`, or `openssl`

Downloaded component artifacts are verified by manifest `sha256` before installation.
For `glm` and `server-bundle`, local and remote component-cache paths also
include that SHA so a hash-triggered deployment cannot accidentally copy bytes
cached under an older artifact with the same semantic version. Other
component-cache key semantics are unchanged.

## Resource Package Compatibility

`SSHConnectOptions.resourcePackages.selectedPackageIds` is still accepted as historical input, but current connections ignore retired package choices and use the default ZCode resource set. Linux remote runtime includes `bfs`, `ripgrep`, and `ugrep`; Darwin remote only deploys its supported `ripgrep` component. Old configs cannot disable active runtime tools or re-enable third-party agent runtimes.

## Key Files

- `packages/server/src/remote/deploy.ts`
- `packages/server/src/remote/zcodeAgentDeploy.ts`
- `packages/server/src/remote/runtimeToolDeploy.ts`
- `packages/shared/src/zcode-agent-runtime.ts`
- `packages/desktop/src/host/remoteWorkspaceServiceCollection.ts`
- `docs/ssh-remote-app-global-state-authority.md`
