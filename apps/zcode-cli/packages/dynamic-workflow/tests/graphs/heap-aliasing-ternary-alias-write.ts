// Conditional alias: `a = flag ? box1 : box2` — at runtime `a` IS one of the two
// boxes, so `a.f = secret` mutates box1.f (flag true) or box2.f (flag false); the
// reader ask interpolates BOTH, so on every execution ask#1's output reaches ask#2.
// Expected: ask#1 -> ask#2 data; ask#2 -> sink.
const box1: { f: string } = { f: "" };
const box2: { f: string } = { f: "" };
const flag = Math.random() > 0.5;
const a = flag ? box1 : box2;
a.f = await agent("writer").ask<string>("secret");
return agent("reader").ask<string>(`use ${box1.f} and ${box2.f}`);
