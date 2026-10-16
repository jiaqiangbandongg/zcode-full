// Nested INLINE fan-outs: agent created inside the inner map (which is inside the
// outer map). Both promote. The actor's `within` must be the INNERMOST fan-out
// (fan-out#2), and the actor-graph `family=` must agree with the site `within=`.
// Distinct from nested-fanout-reach (which routes through helpers — `within` reaches the
// ask/actor there through the call oracle's closure): here the agent is lexically nested,
// exercising innermost-within attribution and its faithful copy into `family`.
const seeds = await files.glob("*.md");
const out = seeds.map((s) =>
  [s].map((y) => agent("inner").ask<string>(`${y}`)),
);
return out;
