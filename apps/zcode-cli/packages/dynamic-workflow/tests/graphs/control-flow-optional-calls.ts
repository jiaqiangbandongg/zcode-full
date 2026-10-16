// Optional calls on facade functions: `planner.ask?.()`, `planner?.ask()`,
// `files.read?.()` are still direct calls at runtime — they must be sited and flow.
const planner = agent("planner");
const a = await planner.ask?.("collect paths");
const b = await planner?.ask(`pick one of ${a}`);
const text = await files.read?.(b);
return agent("act").ask(`done: ${text}`);
