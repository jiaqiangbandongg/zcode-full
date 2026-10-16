// Circular reference (divergence-crash fix): a self-referential object (`a.self = a`)
// carrying real taint used to diverge the fixpoint into the iteration-cap throw. With
// place-aliasing the self link is a single shared node, and cycle-aware, depth-bounded
// merges keep the lattice finite, so the analysis converges and emits a graph. `a`
// escapes to no sink here (the script returns a literal), so the only edge is the
// completion-rule feed to the ask.
// Expected: source -> ask#1 (no throw).
const a: { self?: unknown; f?: string } = {};
a.self = a;
const s = await agent("w").ask<string>("x");
a.f = s;
return "ok";
