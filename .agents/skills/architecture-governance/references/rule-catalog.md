# Rule catalog

| Rule | Meaning | Typical fix |
| --- | --- | --- |
| `module-dependency` | Cross-module import is missing from `requires` | Add a public contract or move the integration owner |
| `deep-import` | Import bypasses a module public entrypoint | Import the contract/index entrypoint |
| `cycle` | The managed dependency graph contains a cycle | Split the owner or invert the dependency through a port |
| `max-file-lines` | Managed source exceeds the policy budget | Split by responsibility; do not add a disable |
| `max-contract-lines` | A contract is too broad | Split the capability or reduce the public surface |
| `max-public-methods` | A contract exposes too many methods | Split the capability or introduce a narrower read/write contract |
| `layer-direction` | A layer imports a higher implementation layer | Depend on a lower layer port or move the integration owner |
| `domain-io` | Domain code imports process, network, filesystem, or timer APIs | Move IO to an adapter and pass a typed port into the domain |
| `ui-implementation-import` | A file in a `ui` layer imports a repository, runtime, or service implementation | Depend on the module port / read model exposed by `contract.ts` |
| `missing-module-artifact` | A managed module lacks its manifest or contract fixtures | Add the required module contract, example, test, and CONTRACT.md |
| `disable-count` | Managed code adds a lint suppression | Fix the underlying violation or add a reviewed expiring exception |
| `unmanaged-new-file` | A newly added source file under `packages/` or `apps/` is not inside a managed module | Put it in a managed module, or run `pnpm architecture:adopt <id> --root <dir>` to register its directory (tests, `.d.ts` and test directories are exempt) |
| `manifest-policy-mismatch` | `module.ts` `requires` disagrees with `architecture-policy.yaml` or names an unknown module | Update both declarations in the same change; the policy owns topology, the manifest owns the local declaration |

Existing violations are suppressible only through `.architecture-baseline.json`; new violations remain blocking.

Import edges are resolved the way Node and TypeScript resolve them: relative paths, `package.json` `imports` (`#src/*`), `tsconfig.json` `paths` (`@/*`), and workspace package names with `exports` (conditional exports and `dist/` targets map back to `src/`). `--changed` compares against a real base (explicit `--base`, CI merge-request variables, pre-push stdin, upstream, then the default branch merge-base), so committed changes are checked in CI and pre-push, not only the dirty working tree.
