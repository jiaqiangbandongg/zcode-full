// Conditional receiver: `(flag ? a : b).ask(...)` — the receiver resolves to a MAY
// set {actor#1, actor#2}. The ask carries actors=actor#1,actor#2, so in the actor
// projection the seed asks feed both candidates inexactly and the shared-actor `a`
// produces a self-edge (a asked at both the seed site and the routed site).
const a = agent("alpha");
const b = agent("beta");
const seed = await a.ask<string>("seed");
const flag = seed.length > 3;
const out = await (flag ? a : b).ask<string>(`route ${seed}`);
return out;
