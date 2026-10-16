// Library mutator Map.set (heap fix): `m.set(k, secret)` folds secret into the map's
// live value, and `m.get(k)` (an unknown library call) reads the receiver whole, so the
// secret rides out at whole-container granularity into the reader ask.
// Expected: source -> ask#1, ask#1 -> ask#2, ask#2 -> sink.
const m = new Map<string, string>();
const secret = await agent("writer").ask<string>("secret");
m.set("k", secret);
const got = m.get("k") ?? "";
const out = await agent("reader").ask<string>(`use ${got}`);
return out;
