// Destructuring aliasing (heap fix): a destructuring declaration off a live place binds
// each extracted name to the container's LIVE field, not a snapshot. `const { o } = wrap`
// makes `o` the same object as `wrap.o`, so `o.f = secret` is visible through `wrap.o.f`.
// Expected: source -> ask#1, ask#1 -> ask#2 (secret through the shared extracted field), ask#2 -> sink.
const wrap = { o: { f: "" } };
const { o } = wrap;
const secret = await agent("writer").ask<string>("secret");
o.f = secret;
const out = await agent("reader").ask<string>(`use ${wrap.o.f}`);
return out;
