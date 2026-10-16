// Composes may-projection + fan-out containment + aggregation in one shape: a ternary
// receiver (actors {a,b}) asked per-element inside a fan-out, with a,b created
// OUTSIDE (idiom B: no family). world-read -> ask fans to workspace->a, workspace->b
// (inexact); ask -> sink fans to a->sink, b->sink (inexact); relays drop;
// workspace->sink is endpoint-endpoint and is filtered. Verifies the ask's
// per-element `within` is intentionally NOT projected onto externally-created lanes.
const files1 = await files.glob("*.md");
const a = agent("a");
const b = agent("b");
const out = files1.map((f) => (f.length > 3 ? a : b).ask<string>(`x ${f}`));
return out;
