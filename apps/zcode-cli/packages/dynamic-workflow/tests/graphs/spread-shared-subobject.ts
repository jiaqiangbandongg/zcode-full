// Object spread `{ ...o1 }` shallow-copies: `o2.inner === o1.inner` (shared reference), so
// writing secret through o2.inner is visible through o1.inner at runtime.
// Expected: source -> ask#1, ask#1 -> ask#2 (secret through the shared inner), ask#2 -> sink.
const o1: { inner: { g: string } } = { inner: { g: "" } };
const o2 = { ...o1 };
const secret = await agent("writer").ask<string>("secret");
o2.inner.g = secret;
const out = await agent("reader").ask<string>(`use ${o1.inner.g}`);
return out;
