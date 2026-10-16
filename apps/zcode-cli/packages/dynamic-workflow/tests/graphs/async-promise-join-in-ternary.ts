// A join under a conditional PLACE: both arms are `Promise.all` calls, so the ternary
// resolves as a place whose may-alias targets are the two join nodes. Divergence repro:
// the pass-fresh join result was the alias target, so the ternary wrapper's set grew every
// pass. Both node kinds are canonical now, so the union saturates.
// Expected: each ask feeds its own join at port 0; the awaited element read reaches the
// sink through BOTH joins (the ternary may be either) and through both asks (additive).
const a = agent("a");
const flag = Math.random() > 0.5;
const pending = flag ? Promise.all([a.ask<string>("one")]) : Promise.all([a.ask<string>("two")]);
const [got] = await pending;
return `${got}`;
