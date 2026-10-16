// An array of agents indexed by a COMPUTED index widens the receiver actor set to
// ALL three agents. The ONLY fixture producing a non-singleton actors= set — the
// documented may-projection. Expect ask#2 actors={actor#1,actor#2,actor#3}, and the
// actor projection fans source -> each and each -> sink, all inexact.
const pool = [agent("a0"), agent("a1"), agent("a2")];
const seed = await agent("seed").ask<string>("pick");
const picked = pool[seed.length]!;
const out = await picked.ask<string>(`go ${seed}`);
return out;
