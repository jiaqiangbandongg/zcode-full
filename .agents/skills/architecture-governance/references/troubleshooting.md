# Troubleshooting

- `module-dependency`: import the target module's public contract, or add the dependency to `module.ts` and policy after confirming the integration owner.
- `deep-import`: replace an internal path with the target module's declared public entrypoint.
- `cycle`: move the shared type into a contract or create an application/integration owner; do not silence the cycle.
- baseline mismatch: run the check without changing baseline, then use `architecture:baseline:update` only in a reviewed migration PR.
