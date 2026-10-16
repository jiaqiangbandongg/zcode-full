# gen-ui-protocol

Pure wire contracts for generated conversation UI. A reference identifies an executor-side file;
it does not grant file access. The target Host authorizes and normalizes paths. Workspace identity
and session isolate state. A state update replaces a JSON snapshot of at most 16 KiB. Only
modelContent can enter bounded, untrusted model context. No MCP plugin identity or tool permission
is implied by a generated UI reference.

Tweak messages follow the upstream registration/update/disposal and ACK lifecycle. Each registration identifies one DOM target and at most 12 typed controls; preview changes carry registrationId, targetId, callback and previousValue. The page owner accepts at most 64 live registrations. This private Gen UI method grants no generic tool access.
