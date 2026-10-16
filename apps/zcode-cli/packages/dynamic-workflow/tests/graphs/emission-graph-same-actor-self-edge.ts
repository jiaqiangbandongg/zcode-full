// One actor, three asks; data flows from ask#1 into ask#2 only. Expected: actor-graph
// SELF-EDGE critic -> critic (count 1, exact) from ask#1 -> ask#2; ask#3 has only
// CONTEXT in-edges, so source completion must still give it source -> ask#3 (context
// edges are not data); context edges dissolve in the projection.
const critic = agent("critic");
const first = await critic.ask<string>("assess");
const second = await critic.ask<string>(`refine ${first}`);
const third = await critic.ask<string>("wrap up");
return `${second} ${third}`;
