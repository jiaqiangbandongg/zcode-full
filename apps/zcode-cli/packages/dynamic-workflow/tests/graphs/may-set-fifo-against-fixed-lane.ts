// A may-set step that MAY share a mailbox with a fixed-lane step: `(f ? a : b).ask(…)`
// issued un-awaited, then `a.ask(…)`. The `fifo` edge exists only because the two may
// both land on alpha, so it attaches to the alpha copy alone — a copy on beta has no
// mailbox relation to a step on alpha, and drawing that pair would claim a serialization
// that cannot exist.
const a = agent("alpha");
const b = agent("beta");
const seed = await agent("seed").ask<string>("pick a route");
const routed = (seed.length > 4 ? a : b).ask<string>(`route ${seed}`);
const direct = await a.ask<string>(`direct ${seed}`);
const settled = await routed;
return `${settled} ${direct}`;
