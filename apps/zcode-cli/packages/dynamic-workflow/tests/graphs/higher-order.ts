// Higher-order dispatch: `f` is dynamically one of two functions. The call resolves
// through the tracked function-value set; a non-singleton set widens (clears
// exactness). Expected: source -> ask#1 exact, ask#1 -> ask#2 INEXACT (widened by
// the higher-order call), ask#2 -> sink exact.
function g(x: string): string {
  return x;
}
function h(x: string): string {
  return `H:${x}`;
}

const seed = await agent("seed").ask<string>("seed");
const f = seed.length > 3 ? g : h;
const routed = f(seed);
const out = await agent("out").ask<string>(`route ${routed}`);
return out;
