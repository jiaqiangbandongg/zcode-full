// Aliasing store (heap fix): `alias` and `box` are the SAME object, so a write through
// the alias is visible through the original. `alias.f = secret` mutates box.f; the
// reader ask then interpolates box.f. Bindings alias, they never snapshot.
// Expected: source -> ask#1, ask#1 -> ask#2 (secret through the shared field), ask#2 -> sink.
const box: { f: string } = { f: "" };
const alias = box;
const secret = await agent("writer").ask<string>("secret");
alias.f = secret;
const out = await agent("reader").ask<string>(`use ${box.f}`);
return out;
