// The THIRD callback parameter of map is the whole iterated array: at runtime
// whole === topics, so whole.join() carries ask#1's artifact into the judge ask.
// Expected: source -> ask#1; ask#1 -> fan-out#1; ask#1 -> ask#2 (MUST);
//           fan-out#1 -> ask#2; sink edges from ask#1/fan-out#1/ask#2.
const s = await agent("planner").ask<string>("plan");
const topics = [s];
const outs = topics.map((_t, _i, whole) => agent("judge").ask<string>(whole.join()));
return outs;
