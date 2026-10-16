// IIFE: an inline arrow invoked immediately with a tainted actual. The parenthesized
// arrow is a direct callee, so the param binding should stay exact.
// Expected: ask#1 -> ask#2 data exact; ask#2 -> sink data exact.
const judge = agent("judge");
const secret = await agent("s").ask<string>("secret");
const out = await ((x: string) => judge.ask<string>(`judge ${x}`))(secret);
return out;
