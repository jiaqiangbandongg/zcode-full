// The CONDITION of a ternary is a real expression: the judge ask inside it reads
// `topic` (ask#1's output) at runtime, on every execution.
// Expected: ask#1 -> ask#2 data (topic into judge's instructions); ask#2's actor
// set = actor#2 (judge); ask#3 gets its instructions from a literal-only ternary.
const topic = await agent("scout").ask<string>("pick a topic");
const mode = (await agent("judge").ask<string>(`judge ${topic}`)) === "hot" ? "hot" : "cold";
return agent("writer").ask<string>(`write a ${mode} take`);
