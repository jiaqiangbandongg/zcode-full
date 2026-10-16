// Object.assign (heap fix): a free function that mutates its target in place, copying
// each source's props. `Object.assign(target, { f: secret })` makes target.f observe
// secret; the reader ask interpolates target.f.
// Expected: source -> ask#1, ask#1 -> ask#2 (secret through the assigned field), ask#2 -> sink.
const target: { f: string } = { f: "" };
const secret = await agent("writer").ask<string>("secret");
Object.assign(target, { f: secret });
const out = await agent("reader").ask<string>(`use ${target.f}`);
return out;
