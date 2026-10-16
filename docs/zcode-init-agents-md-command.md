# ZCode `/init` AGENTS.md Command

## Feature Summary

| Field | Value |
| --- | --- |
| Change | Add a built-in `/init` prompt command that creates or updates the current workspace `AGENTS.md`. |
| User-visible surfaces | Desktop app slash suggestions, app `--stdio` prompt send path, CLI/TUI slash command help and dispatch. |
| Existing docs | `docs/architecture/zcode-code-architecture-overview.md`, `docs/architecture/message-flow.md`, `apps/zcode-cli/docs/design/agents-user-instructions-merge.md`, `docs/settings-directory-sources.md`. |
| Existing code owners | Agent bootstrap input facade, ZCode Protocol slash command list, CLI command center, UI slash suggestions. |
| Out of scope | New ZCode Protocol method, mobile-only replay semantics, global `~/.zcode/AGENTS.md` initialization, conversation E2E expansion. |

## Clarification Log

| Round | Question | User answer | Boundary fixed | Follow-up needed |
| --- | --- | --- | --- | --- |
| 1 | Should ZCode mirror Claude-style `/init`, but target ZCode instructions? | "加一下" after the proposed plan. | Implement `/init` as a built-in prompt command that creates `AGENTS.md`. | no |
| 1 | Is `AGNENTS.md` intended literally? | Not corrected after the plan; project source of truth is `AGENTS.md`. | Treat `AGNENTS.md` as a typo and create/update `AGENTS.md`. | no |
| 1 | Should v1 include user-global instructions? | No explicit request. | v1 targets the current workspace root only. | yes, future `/init --user` can be specified later. |

## Boundary Decisions

| Boundary | Decision | Includes | Excludes / prunes | Source |
| --- | --- | --- | --- | --- |
| Command semantics | `/init` is a normal prompt command, not a session command. | The UI sends `/init` through normal prompt send/queue flow; agent rewrites it into an initialization prompt. | No `session/init` protocol method and no special UI session-control path. | `docs/architecture/message-flow.md`, code inspection |
| Target file | Current workspace root `AGENTS.md`. | Missing file creation; existing file read and patch. | `CLAUDE.md`, `AGNENTS.md`, user-global `~/.zcode/AGENTS.md`. | User request and `agents-user-instructions-merge.md` |
| Existing hidden instructions | Check workspace `.zcode/AGENTS.md` and `.agents/AGENTS.md` before creating a new root file. | If either hidden-path instruction file exists, tell the user instructions already exist and no new file is needed. | Creating a duplicate root `AGENTS.md` in that case. | User follow-up |
| App support | Support app `--stdio` by reusing `session/send`. | `session/send -> record.app.sendInput -> input facade prompt resolver -> runtime turn`. | Relay/main ownership of business state. | `docs/architecture/zcode-code-architecture-overview.md` |
| Command ownership | Built-in `/init` reserves the `init` name. | App slash list and CLI help include `/init`; custom `/init` is hidden by reserved-name filtering. | Letting custom `/init` override builtin behavior. | Existing reserved command model |
| Running session behavior | `/init` behaves like ordinary prompt input. | Completed sessions send immediately; running/compacting behavior follows existing queue/steer guards. | Special compact/goal control handling. | `docs/conversation-protocol-declaration.md` |
| Visible query text | Provider input and UI-visible query are split. | The model receives the expanded `/init` prompt; TurnStarted, transcript, title seed, and UI snapshots keep the original `/init ...` user query. | Showing the long built-in prompt in the user bubble. | Runtime bug report `sess_12c80069-7d45-4288-959f-fb64c608cb97` |

## Domain Scope

| Domain | Include? | Why it can change behavior | Primary sources |
| --- | --- | --- | --- |
| Architecture/process boundary | yes | The requested app support depends on stdio and ownership boundaries. | `docs/architecture/zcode-code-architecture-overview.md`, `docs/architecture/message-flow.md` |
| Conversation/session behavior | yes | `/init` enters through normal prompt send and queue behavior. | `docs/conversation-protocol-declaration.md`, `docs/conversation-product-state-space.md` |
| Permission/tool/MCP/subagents | yes | The generated turn may use `Read`, `Glob`, `Grep`, `Bash`, `Write`, and `Edit`, all through existing permission flow. | `docs/permission-project-approval.md`, protocol tool event code |
| UI shell/theme/locale/responsive | limited | UI change is only slash suggestion visibility, no new component or layout. | `DESIGN.md`, `packages/ui/src/slashCommandHelpers.ts` |
| Mobile remote/replayable realtime | pruned | No new replayable command path; normal prompt delivery continues to use existing client mode boundaries. | `docs/web-remote-control/task-realtime-sync.md` |

## Concept Map

| Concept | Why it matters | Source |
| --- | --- | --- |
| `AGENTS.md` instruction merge | Confirms ZCode already reads user default and workspace `AGENTS.md`; `/init` creates the workspace source file. | `apps/zcode-cli/docs/design/agents-user-instructions-merge.md` |
| Input facade command resolver | Existing place where submitted prompt text can be rewritten before runtime execution. | `apps/zcode-cli/packages/bootstrap/src/app/input-facade.ts` |
| Protocol slash command list | App snapshots use this list to show built-in and custom commands. | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/slash-commands.ts` |
| UI visible slash filter | The app hides unsupported builtins locally even if older protocol snapshots contain them. | `packages/ui/src/slashCommandHelpers.ts` |
| CLI command center | TUI parses known slash commands locally; known commands need explicit dispatch to avoid resume fallback. | `apps/zcode-cli/packages/cli/src/command-center/create.ts` |

## State Owners

| State / fact | Authority | Mirrors / caches | Evidence |
| --- | --- | --- | --- |
| Slash command availability | Agent protocol snapshot | UI task meta slash command cache | `listProtocolSlashCommands` unit test |
| Prompt text rewrite | Agent bootstrap input facade | none | Resolver unit test and app submit path |
| `AGENTS.md` file contents | Workspace filesystem | Future context source reads | Runtime/tool events and file existence |
| Running/queued behavior | Existing session service and UI queue | Task store projection | Existing conversation matrix; no new E2E in v1 |

## Dimensions

| Dimension | Values / equivalence classes | Include? | Reason |
| --- | --- | --- | --- |
| Client surface | desktop app stdio, TUI, headless `--prompt` | yes | All should route `/init` to the same resolver. |
| Workspace file state | missing `AGENTS.md`, existing `AGENTS.md`, hidden `.zcode/AGENTS.md` or `.agents/AGENTS.md` present | yes | Prompt must distinguish write, edit, and no-op-with-message. |
| Command source conflict | builtin `init`, custom `init` | yes | Builtin reserves the name. |
| Session phase | completed, running/compacting | limited | Reuse existing normal prompt behavior; no new product rule. |
| User-global target | `~/.zcode/AGENTS.md` | pruned | Not in v1. |

## Candidate Combinations

| Candidate ID | State | Event | Target/surface | Expected guard/effect | Initial status | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| INIT-01 | Workspace has no `AGENTS.md` | User sends `/init` | Desktop app stdio | Normal prompt starts; model inspects repo and writes workspace `AGENTS.md`. | accepted | Covered by prompt resolver and slash visibility tests; manual runtime smoke can verify file write. |
| INIT-02 | Workspace has existing `AGENTS.md` | User sends `/init` | Any surface | Model reads existing file and edits it, avoiding overwrite. | accepted | Prompt-level behavior. |
| INIT-03 | Custom command `/init` exists | Slash list/submit | Agent command discovery | Builtin command wins; custom `/init` hidden/reserved. | accepted | Keeps builtins predictable. |
| INIT-04 | Running session | User sends `/init` | App composer | Existing normal prompt queue/steer behavior applies. | accepted | No special session command branch. |
| INIT-05 | User requests global instructions | User sends `/init --user` | Any surface | v1 treats args as additional instruction but prompt keeps workspace target. | pruned | Future feature can add explicit `--user`. |
| INIT-06 | App/stdIO sends `/init` | Runtime prompt resolver expands command | App composer and transcript | Provider receives expanded prompt; UI-visible user message remains `/init`. | accepted | Regression from `sess_12c80069-7d45-4288-959f-fb64c608cb97`. |
| INIT-07 | Workspace has `.zcode/AGENTS.md` or `.agents/AGENTS.md` | User sends `/init` | Any surface | Agent tells the user instructions already exist and does not create a duplicate root `AGENTS.md`. | accepted | User follow-up. |

## Pruning Decisions

| Decision ID | Pruned combinations | Guard/invariant | Product reason | Representative coverage |
| --- | --- | --- | --- | --- |
| P-INIT-USER | Global user `AGENTS.md` creation | v1 target is workspace root | Avoid mixing user defaults with repo-specific onboarding. | Resolver prompt text states workspace target. |
| P-INIT-PROTOCOL | New `session/init` method | Agent owns prompt turns; app sends normal prompt | Existing stdio permission/event flow already covers tools and file edits. | `session/send` path remains unchanged. |
| P-INIT-SPECIAL-UI | UI session-control command branch | `/init` is not compact/goal | Avoid duplicating queue and mobile replayable command semantics. | `parseZCodeVisibleSlashCommand("/init") === null`. |

## Accepted Cases

| Case ID | Setup | Action | Assertions | Evidence layers | E2E status |
| --- | --- | --- | --- | --- | --- |
| INIT-A | Protocol slash discovery has builtin list and no custom conflict | Read slash commands | `/init` appears as builtin; custom `/init` is filtered. | unit | planned |
| INIT-B | Input facade receives `/init extra notes` | Resolve prompt | Runtime prompt mentions workspace `AGENTS.md`, target path, and extra notes. | unit | planned |
| INIT-C | UI receives builtin `/init` from agent | Build slash suggestions | `/init` is visible; `/model` remains hidden. | unit | planned |
| INIT-D | UI prompt-control parser receives `/init` | Parse visible command | Returns null so normal prompt send path handles it. | unit | planned |
| INIT-E | TUI command center receives `/init` | Submit command | Dispatches to active app `submitPrompt("/init")`, not resume. | unit | planned |
| INIT-F | App facade submits `/init include package scripts` | Resolve and execute turn with fake model | Provider request includes expanded `/init` prompt; transcript and TurnStarted input show `/init include package scripts`. | unit | planned |
| INIT-G | Input facade receives `/init` | Resolve prompt | Runtime prompt asks to check `.zcode/AGENTS.md` and `.agents/AGENTS.md`, and to stop with a user message if either exists. | unit | planned |

## Matrix Backfill

| File | Change |
| --- | --- |
| case catalog | No conversation E2E is added in v1; normal prompt queue behavior is covered by existing catalog. |
| coverage matrix | No matrix row is needed unless a future GUI E2E is added for runtime file creation. |
| decision worksheet/backlog | Future `/init --user` remains undefined and should get a separate spec before implementation. |

## E2E Handoff Notes

- Provider fixture: a future manual-review GUI case can use a deterministic model trace that asks for `Glob`, `Read`, and `Write`.
- File-system fixture: create a temp workspace with and without `AGENTS.md`; assert only `AGENTS.md` is changed.
- Timing strategy: use completed session for the first GUI case; running-session queue behavior is inherited from existing prompt queue cases.
- Docker preset: not required for v1 unit coverage.
- Review risks: the prompt determines file quality; future acceptance should inspect generated `AGENTS.md` content rather than only file existence.
