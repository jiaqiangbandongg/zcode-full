# Log Export Retention

Desktop log export keeps recent runtime evidence while avoiding oversized support bundles.

## Retention Window

Runtime log-like files are filtered by file `mtime` and only exported when they were modified in the last 3 days. This applies to:

- `logs/**`
- `.zcode/cli/log/**`

Retired proxy traffic capture and provider config directories are not current ZCode runtime log sources. If they still exist on a user's machine, they are treated as legacy data rather than first-class export targets.

## Excluded Legacy State

Legacy session snapshots, session binding files, and Git checkpoint manifests are skipped entirely. Current ZCode agent diagnostics come from logs, current configuration, sqlite-backed session metadata, and CLI runtime traces; these legacy state directories mostly add bundle size without improving support triage.

Skipped directories:

- `sessions/**`
- `session-bindings/**`
- `checkpoints/**`

## Excluded Credential Stores

Credential store files are skipped by file name before the archive is written. Redaction still applies to ordinary logs and configuration files, but standalone credential stores are not diagnostic material and must not be included in either manual log export or feedback full-log archives.

Skipped file names:

- `credentials.json`
- `.credentials.json`

## Excluded Agent Runtime and Certificate State

Agent workspace configuration and application CA certificate state are skipped at the
`~/.zcode/v2` top level before traversal. These directories are runtime state rather than
diagnostic logs; they may contain sensitive provider configuration, certificate material,
or large generated files that should not be present in support bundles.

Skipped directories:

- `agent-config/**`
- `certs/**`

This boundary applies to both manual desktop log export and feedback full-log archives.
Only these top-level `~/.zcode/v2` directories are matched; an unrelated nested directory
with the same name in another log source is not excluded by this rule.

## Excluded Debug Directories

Directories named `debug` are skipped by path segment before the archive is written. These directories usually contain verbose model/runtime traces rather than user-facing support logs, and may grow quickly or include sensitive request context. This applies to manual log export and feedback full-log archives.

Examples:

- `debug/**`
- `**/debug/**`
- `.zcode/cli/debug/**`

## Retired Runtime Directories

Retired runtime directories are skipped entirely because they may contain stale provider databases, traffic captures, or legacy auth material that can dominate the bundle size. Current `agent-config/**` runtime state is excluded separately under the same full-log archive privacy boundary.

Skipped directories:

- `acp-auth/**`
- `acp-config/**`
- `acp-stream-diagnostics/**`
- `acp-traffic-proxy/**`

## Excluded Generated Assets

Generated assets, dependency installs, and runtime caches are skipped entirely because they are not useful support evidence and can dominate the bundle size.

Examples:

- `Library/Caches/**`
- `.zcode/cli/node_modules/**`
- `.zcode/cli/.tmp/**`
- `.zcode/cli/tmp/**`
- `.zcode/cli/skills/**`
- `.zcode/cli/plugins/**`

## Preserved Files

Configuration and binding files are not filtered by this retention window because they may be old but still define the current runtime behavior. They continue to pass through the existing export redaction pipeline.

Examples:

- `.claude.json`
- `.zcode/cli/settings.json`

## Redaction Allowlist

The export redaction pipeline preserves exact LLM token count and budget fields that are
required for provider request diagnosis. This includes `max_tokens` and the nested
`thinking.budget_tokens` key, together with their existing camel-case and hyphenated
spellings.

The allowlist must remain explicit. Credential-bearing names such as `access_tokens`,
`refresh_tokens`, and `session_tokens` stay redacted; arbitrary `*_tokens` fields must not
be allowlisted. Manual log export and feedback full-log archives share this boundary.
