// Boundary probe: `Pick<Agent, "ask">` is a mapped type over the FACADE interface, so its
// `ask` property may still trace back to the facade declaration (unlike a fresh local
// interface). If it does, the call is sited/flagged; if the mapped-type property is a
// synthesized symbol with no facade declaration, it escapes like the retype hole.
const planner = agent("planner");
const seed = await agent("seed").ask<string>("seed");
const d = planner as Pick<Agent, "ask">;
const out = await d.ask(`route ${seed}`);
return out;
