// A class extending a mixin CALL (`class D extends mix(Base) {}`). D itself resolves,
// but its heritage expression is a call, so the base class (and the inherited ctor)
// cannot be found. Runtime: new D(<ask result>) forwards through the implicit ctor
// chain to Base's ctor, which stores the artifact in this.v; d.v then feeds ask#2.
// Expected: source -> ask#1, ask#1 -> ask#2 (base ctor -> this.v -> d.v), ask#2 -> sink;
// ask#1 carries actors=actor#1.
const seed = agent("w").ask<string>("s");
class Base {
  v = "";
  constructor(x: string) {
    this.v = x;
  }
}
function mix(B: typeof Base) {
  return class extends B {};
}
class D extends mix(Base) {}
const d = new D(await seed);
const out = await agent("r").ask<string>(`use ${d.v}`);
return out;
