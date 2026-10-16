// One edge, two witnesses: `a` reaches ask#2 directly (exact) AND through a
// computed-index container read (inexact). Dedup by (from,to,kind,port) must OR the
// exactness: exactly ONE ask#1 -> ask#2 data edge, exact.
const a = await agent("one").ask<string>("A");
const arr = [a, "pad"];
const i = a.length % 2;
const picked = arr[i];
return agent("two").ask<string>(`${a} :: ${picked}`);
