// A straight artifact chain: each ask consumes the previous one's result.
// Expected: source -> ask#1, ask#1 -> ask#2 (via the template), ask#2 -> sink, all exact.
const a = await agent("alpha").ask<string>("start");
const b = await agent("beta").ask<string>(`continue: ${a}`);
return b;
