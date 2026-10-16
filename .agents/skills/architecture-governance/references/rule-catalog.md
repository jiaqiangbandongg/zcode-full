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
| `ui-implementation-import` | UI imports a repository, runtime, or service implementation | Call a UI hook backed by the service contract |
| `missing-module-artifact` | A managed module lacks its manifest or contract fixtures | Add the required module contract, example, test, and CONTRACT.md |
| `disable-count` | Managed code adds a lint suppression | Fix the underlying violation or add a reviewed expiring exception |

Existing violations are suppressible only through `.architecture-baseline.json`; new violations remain blocking.
