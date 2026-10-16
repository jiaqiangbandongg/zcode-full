// Object.assign shallow-copies: after the call `target.inner === src.inner` (one shared
// object). Mutating the shared inner through target is visible through src at runtime, so
// secret written via target.inner.g reaches the reader ask reading src.inner.g.
// Expected: source -> ask#1, ask#1 -> ask#2 (secret through the shared inner), ask#2 -> sink.
const target: { inner: { g: string } } = { inner: { g: "" } };
const src: { inner: { g: string } } = { inner: { g: "" } };
Object.assign(target, src);
const secret = await agent("writer").ask<string>("secret");
target.inner.g = secret;
const out = await agent("reader").ask<string>(`use ${src.inner.g}`);
return out;
