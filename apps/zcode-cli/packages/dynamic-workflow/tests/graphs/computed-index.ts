// Computed (dynamic) index access is THE widening rule: reading `items[i]` with a
// non-literal index reads the whole container inexactly. Expected: source -> ask#1
// exact, ask#1 -> ask#2 INEXACT (the computed index widened the flow), ask#2 -> sink.
const seed = await agent("seed").ask<string>("seed");
const items = [seed, "literal"];
const i = seed.length % 2;
const picked = items[i];
const out = await agent("out").ask<string>(`chose ${picked}`);
return out;
