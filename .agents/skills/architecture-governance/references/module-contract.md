# Managed module contract

A managed module exposes only its contract entrypoint. The contract contains branded identifiers, schemas, typed commands, events, errors, and the semantics required by callers. `domain` stays pure, `app` owns use-case orchestration, `adapters` owns IO and process boundaries, and `ui` consumes the module port/read model.

The example and contract test are part of the agent context package. The short `CONTRACT.md` records only invariants that types and tests cannot express.
