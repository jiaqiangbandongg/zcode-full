// Optional-chain call forms should still SITE (the callee is a PropertyAccess with a
// question-dot). `files.read?.(p)` and `planner?.ask?.(p)` are direct calls. Expected:
// world-read#1 and ask#2 sited normally; seed flows into both. No diagnostic.
const seed = await agent("seed").ask<string>("seed");
const c = await files.read?.(`ws/${seed}`);
const planner = agent("planner");
const out = await planner?.ask?.<string>(`use ${c}`);
return out;
