# ZCode CUA Permission Broker

## Product boundary

### 2026-08 node_repl migration override

CUA 不再注册或启动独立 `zcode-cua` MCP。模型只看到 shared `node_repl` 的工具（成文时是三个，
`js_reset` 与 `js_add_node_module_dir` 已于 2026-09-18 删除，现在只有 `js`）；
`computer-use-client.mjs` 在 Worker 内注入 `agent.computerUse`，请求经一次性认证的本地
bridge 路由到 shared-host `CuaControlPort`。broker socket/token 只恢复给可信 node_repl
子进程，旧的 CUA argv/env 注入入口、旧 MCP aliases 和旧 server 配置均被 bootstrap 丢弃；
历史段落中关于“注入 zcode-cua server”的描述仅保留为迁移前威胁模型，不是当前执行路径。

桌面链路保持 `desktop-continuous`，手机链路只能 `web-remote-replayable` attachment 到已有
桌面 host。Helper、TCC、frame freshness、kill switch、input hold 和 `possibly_sent` 仍在
runtime 内部执行，relay/main 不承载这些状态。

Product CUA runs through the signed `ZCode Computer Use.app`. ZCode launches that helper with a freshly minted Unix socket and auth token, waits for `broker_info`, and injects the credentials into the shared `node_repl` host; the host's CuaControlPort is the only SDK-to-Helper execution bridge.

The broker must fail closed:

- If the helper is missing, cannot launch, rejects the token, or does not become healthy, ZCode must not inject broker credentials.
- If `broker_info.bundle_id` is present and is not `dev.zcode.cua-helper`, product startup must fail with `CuaHelperError`; a warning is not sufficient because TCC grants would belong to the wrong process identity.
- Desktop product mode keeps the Helper as the TCC owner. Python/uvx must never become the implicit permission owner.
- The broker token is a **bearer credential scoped to the target `zcode-cua` MCP server only**. It must be injected into that server's own `env`/args, must NOT be **retained/inherited** in the agent's global runtime env, and must NOT reach other MCP servers, hooks, or Bash/tool subprocesses (a leaked token lets any same-agent process drive the TCC-owning Helper — the confused-deputy this design prevents). The sole exception is a bounded _transitional_ delivery on the global-CLI path: `node.ts` places the socket/token in the agent spawn env, but the CLI entry sanitization **captures them into a process-private store and deletes them from `process.env` before any bootstrap/tool code runs** (see the two-path description below) — so they are never retained in the runtime global env nor inherited by any child. `sanitizeZCodeRuntimeEnv` strips `ZCODE_CUA_PERMISSION_BROKER_TOKEN`/`_SOCKET` from all spawned child envs (and the tool-env passthrough), while the desktop/CLI resolver re-injects them into the `zcode-cua` server env only. Two delivery paths, both sanitization-safe: (a) a **desktop-spawned** `zcode-cua` gets the socket/token via the `session/create` `mcpServers` per-server `env` (spread _after_ `buildMcpStdioEnv`), never touching `process.env`; (b) a `zcode-cua` declared in the **global `~/.zcode/cli/config.json`** arrives in the CLI child's `process.env`, where the CLI entry sanitization **captures** the socket/token into a process-private in-memory store _before_ deleting them from `process.env`, and the CLI bootstrap resolver reads that store (not `process.env`) to inject them into the `zcode-cua` server env. Reading `process.env` directly would fail closed here: without the captured broker tuple the global `zcode-cua` is **omitted entirely** rather than started raw. A token written to disk (one-shot `--token-file`) is a same-UID exposure, so the broker adds **peer verification** as a required second gate in product. Because `--launcher-pid` is caller-supplied, the ancestry gate only means something once the launcher is _proven_ to be ZCode — otherwise an attacker could pass their **own** pid as `--launcher-pid`, self-mint a `--token-file`, `open` the already-authorized `ZCode Computer Use.app`, and connect from their own process tree. So the Helper first verifies, via native `SecCodeCheckValidity` on the `--launcher-pid` process (`verifyProcessCodeSignature`), that the launcher satisfies ZCode's code-signing requirement — `anchor apple generic and identifier "dev.zcode.app" and certificate leaf[subject.OU] = "8A5X4JJ39T"` (bundle id + Team-pin, env-overridable via `ZCODE_CUA_LAUNCHER_BUNDLE_ID` / `ZCODE_CUA_HELPER_TEAM_ID`). Only then does it accept a connection whose peer (a) has the current uid and (b) is in the process tree of that verified ZCode launcher (native `getpeereid` + `LOCAL_PEERPID`, walked to `--launcher-pid`). Net: a same-UID process outside the _genuine_ ZCode's process tree is rejected, and a self-reported/forged launcher pid cannot stand in for ZCode. Product mode **fails closed** if any gate cannot be established (missing/unverifiable `--launcher-pid`, a native build without `verifyProcessCodeSignature`/`getPeerCredentials`, or a launcher not matching the ZCode requirement). Residual (tracked as issue #7): a genuine ZCode-descendant sibling that actively reads the token-file within its brief one-shot window is still inside the accepted tree; fully closing that requires pinning the token to the exact `zcode-cua` pid (a vouch/reverse-handshake), a follow-up on top of this ancestry + launcher-identity gate + the token env-scoping above.
- The default launcher code requirement is `anchor apple generic and (identifier "dev.zcode.app" or identifier "dev.zcode.app.preview") and certificate leaf[subject.OU] = "8A5X4JJ39T"`. This supersedes the production-only requirement string retained in the historical threat-model narrative above. It must not be widened to a Team-only requirement because another app signed by the same Team is not an authorized CUA launcher. `ZCODE_CUA_LAUNCHER_BUNDLE_ID` remains a development-only single-id override.
- The Helper is a **desktop-local macOS** authorization subject only. A `desktop-attached-remote` host (mobile `/remote`, SSH/WSL/container workspaces) must NOT auto-install or launch the Helper, run the orphan reaper, or wire the product MCP resolver — remote sessions attach through the shared desktop host rather than standing up a separate permission chain on the remote. `createLocalServices` enforces this via `shouldCreateDefaultCuaProductHelper` (false for `desktop-attached-remote`). Remote macOS support, if ever added, needs its own install/authorization/UI/failure spec first.
- Product CUA is enabled by default on supported desktop platforms. `ZCODE_CUA_PRODUCT_HELPER=0|false|off`
  is the explicit kill switch; disabled mode has zero footprint: no host object, orphan-reaper scan,
  resolver injection, Helper process, or TCC prompt. The Helper remains demand-started and is installed
  on first CUA use from the signed copy inside `ZCode.app/Contents/Resources/cua-helper/`; production never
  downloads it and fails closed if that bundle is missing or invalid.
- **Re-verify before every launch (not just at install).** The install verifies the bundle and clears its quarantine xattr, so `open` will not re-assess it via Gatekeeper. Verifying only at install checks one inode while a later `launch` could run a different one — a same-UID attacker can overwrite `…/computer-use/ZCode Computer Use.app/Contents/MacOS/…` after install and get it launched with TCC (peer/token gates only decide _who connects_, not _which binary started_). So `cuaHelperHost.doStart` re-runs `verifyInstalled` (signature / Team / bundle / version) on the resolved `Helper.app` immediately before `launcher.launch`, minimizing the TOCTOU window; a failing verify never launches.
- A direct `zcode` CLI run (not launched by ZCode desktop) that has a global `zcode-cua` but no resolvable broker socket **omits `zcode-cua` (fail-closed) on macOS** rather than running it without the Helper-owned broker. This is unconditional — it does not require `ZCODE_CUA_PERMISSION_BROKER_UNAVAILABLE` to be set. A `zcode-cua` whose own per-server `env` already carries the broker socket (desktop `session/create` path) is kept; local dev can opt into running raw with `ZCODE_CUA_HELPER_ALLOW_UNAUTHENTICATED_LOCAL=1`.
- The `zcode-cua` matcher (`@zcode/shared` `mcp.ts`, single source of truth for both injection entries) must recognize every form that resolves to the real package — including `python -m zcode_cua.server` (dot submodule) and local paths with a trailing separator (`…/zcode-cua/`) — because a missed match is fail-open (no broker injected → raw TCC owner), while an over-match is fail-closed (harmless broker injection).

## `open_application` Result Contract

`open_application` is allowed to report LaunchServices dispatch success before the AX
application list has refreshed. This avoids a false negative where a browser visibly
opens a URL but the immediate AX resolver cannot yet find the process.

The result has three trust levels:

- **AX resolved:** `pid` is positive and comes from the AX application resolver.
  This is a process-scoped app reference.
- **Launch pid hint:** `pid` is positive and comes from the platform launcher
  hint. On macOS, when `bundle_id` is supplied, the hint must resolve the bundle's
  `CFBundleExecutable` first and only then look up that executable's PID. It must
  not use the display `name` as a fallback for a bundle launch because that can
  select an unrelated running process.
- **Dispatch-only acknowledgement:** `pid` is `null`, with the requested
  `bundle_id` and/or `name`. This only proves that LaunchServices accepted the
  open request. Callers must not treat it as a process-scoped reference for
  app-scoped keyboard/input. They should re-observe or resolve by bundle/name
  before sending process-scoped input.

Actual launcher failure still fails closed with `permission_denied`. Only a
successful dispatch may produce a `pid:null` acknowledgement.

## Authorization Subject Diagnostics

`broker_info.authorization_subject` and `request_access.owner` expose the runtime identity that macOS will see for Accessibility, Screen Recording, and Automation prompts.

The helper default broker info must include the fields that can be reliably obtained without extra dependencies:

- `kind`
- `bundle_id`
- `display_name`
- `version`
- `pid`
- `app_bundle_path`
- `code_signing_identifier`
- `team_identifier`
- `signature`
- `stable_identity`
- `warnings`

In packaged macOS builds, `code_signing_identifier` and `team_identifier` come from `/usr/bin/codesign -dv --verbose=4`. In development or non-macOS tests, missing signing data is allowed, but it must be reported as diagnostics instead of silently pretending the identity is stable.

## Permission status query modes

macOS permission status has two deliberately different modes:

- Omitted options or `includeFunctionalProbes:false` is read-only. Settings mount, timer polling,
  window focus and ordinary refresh use this mode and must never perform pixel capture.
- `includeFunctionalProbes:true` is an active pixel probe. The Settings surface may request it only
  once after an explicit permission-return or successful Helper restart.

The renderer coalesces concurrent refresh requests with OR semantics. At most one queued query carries
the active flag; later read-only refreshes cannot erase it. A workspace/context change invalidates the
queued request and any late result. After one active result establishes readiness, the existing
renderer-local sticky-ready snapshot may preserve that result while subsequent polling remains read-only.
Remote/mobile attachment never originates this probe and never creates a Helper.

## Shared node_repl SDK contract

The bundled `@zcode/zcode-cua-plugin` is a skill/docs/SDK package. `scripts/computer-use-client.mjs`
bootstraps `agent.computerUse` inside each fresh shared `node_repl` Worker. It never exposes broker
socket/token/native modules to the Worker; the shared host validates the authenticated request context and
delegates to the pinned `@zcode/zcode-cua` runtime. There is no independent CUA MCP launcher or model-visible
`mcp__computer-use__*` projection. Release provenance remains owned by the signed SEA bundle,
codesign/notarization and the existing Helper/runtime attestation gates.

The wrapper is now an SDK script and does not build a CUA `dist/mcp/server.js`. Browser Use alone owns
the bundled `node_repl` MCP server; CUA seeding copies `scripts/computer-use-client.mjs`, docs and Skill.
Do not restore a CUA `mcpServers` manifest entry or a second launcher.

`stable_identity=true` means the runtime identity is a signed app bundle whose signing identifier matches the expected bundle id and has a team identifier. Otherwise, `warnings` must explain which signal is missing or mismatched.
