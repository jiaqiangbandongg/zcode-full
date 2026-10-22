# Troubleshooting

- `module-dependency`: import the target module's public contract, or add the dependency to `module.ts` and policy after confirming the integration owner.
- `deep-import`: replace an internal path with the target module's declared public entrypoint.
- `cycle`: move the shared type into a contract or create an application/integration owner; do not silence the cycle.
- `unmanaged-new-file`: the file is new relative to the diff base and sits in a legacy root. Either move it into an existing managed module or register its directory with `pnpm architecture:adopt <id> --root <dir> --layer <domain|app|adapters|ui>`; adopt scaffolds the five artifacts and infers `requires` from real imports.
- `manifest-policy-mismatch`: edit `module.ts` and `architecture-policy.yaml` together; unknown ids usually mean the dependency has not been registered yet.
- unexpected base: run `pnpm architecture:check -- --changed --base <sha>` to pin the comparison; the report prints the chosen base.
- baseline mismatch: run the check without changing baseline, then use `architecture:baseline:update` only in a reviewed migration PR.
