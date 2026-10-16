// Asks that are dead code AFTER the top-level return. Analysis is flow-insensitive (no
// dead-code elimination): both are still sited and `${await x}` still emits ask#1 -> ask#2.
// ask#1 reads only a literal so source-completion adds source -> ask#1; ask#2 already has
// an incoming edge so it is not completed. The return is a literal, so the sink is edge-less.
// Projection: source -> actor#1 -> actor#2; the incident-free sink endpoint is pruned.
const a = agent("alpha");
const b = agent("beta");
return "done";
const x = await a.ask<string>("never runs");
const y = await b.ask<string>(`also ${await x}`);
