// Aggregation rules in one shape: seed feeds a two-actor pick (inexact, {a,b}) AND
// feeds `a` directly (exact). The two site edges that collapse onto seed->a merge
// with exact = OR over contributors (exact, count=2); the seed->b sibling stays
// inexact (count=1). The context edge between the two asks of overlapping actor sets
// dissolves (sharing an actor is being the same node here).
const a = agent("a");
const b = agent("b");
const seed = await agent("seed").ask<string>("s");
const chosen = seed.length > 3 ? a : b;
const m = await chosen.ask<string>(`use ${seed}`);
const direct = await a.ask<string>(`also ${seed}`);
return `${m} ${direct}`;
