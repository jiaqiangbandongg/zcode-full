// Boundary probe: `{ ...planner }` — at runtime spreads the agent's own enumerable props
// (the real ask fn ref survives), so `d.ask(seed)` calls the real facade ask. The spread
// type's `ask` property symbol may be synthesized (no facade decl) => potential escape.
const planner = agent("planner");
const seed = await agent("seed").ask<string>("seed");
const d = { ...planner };
const out = await d.ask(`route ${seed}`);
return out;
