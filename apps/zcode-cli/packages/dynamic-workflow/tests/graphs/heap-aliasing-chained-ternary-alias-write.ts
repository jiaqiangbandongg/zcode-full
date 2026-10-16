// Chained conditional alias: `d` may be `a`, and `a` may be `b` or `c`, so at runtime
// `d` may BE `b`. A write through `d` must reach b.f (and c.f, e.f) — the may-alias
// replay has to RECURSE into a's own may-alias targets, or b/c miss the write.
// Expected: ask#1 -> ask#2 data (via b.f); ask#2 -> sink.
const b: { f: string } = { f: "" };
const c: { f: string } = { f: "" };
const e: { f: string } = { f: "" };
const flag = Math.random() > 0.5;
const flag2 = Math.random() > 0.5;
const a = flag ? b : c;
const d = flag2 ? a : e;
d.f = await agent("writer").ask<string>("secret");
return agent("reader").ask<string>(`use ${b.f}`);
