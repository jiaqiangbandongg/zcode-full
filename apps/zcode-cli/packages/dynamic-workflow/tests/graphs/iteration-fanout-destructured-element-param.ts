// map with a DESTRUCTURED element parameter ({ q }): at runtime q is element.q,
// which carries ask#1's artifact — the judge's instructions are tainted by it.
// Expected: source -> ask#1; ask#1 -> fan-out#1; ask#1 -> ask#2 (MUST);
//           fan-out#1 -> ask#2; ask#1/fan-out#1/ask#2 -> sink.
const s = await agent("planner").ask<string>("plan");
const jobs = [{ q: s }];
const outs = jobs.map(({ q }) => agent("judge").ask<string>(q));
return outs;
