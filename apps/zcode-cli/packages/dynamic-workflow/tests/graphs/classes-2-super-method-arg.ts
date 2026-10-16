// A derived method (different name from the base method) forwards its argument to
// super.store(x), which writes this.v on the shared instance. At runtime
// d.put(secret) => super.store(secret) => this.v = secret => d.v feeds ask#2.
// Probe: does the argument of a `super.m(arg)` call reach the base method's parameter?
// Expected: source -> ask#1, ask#1 -> ask#2 (via this.v), ask#2 -> sink.
const secret = await agent("writer").ask<string>("secret");
class Base {
  v = "";
  store(x: string) {
    this.v = x;
  }
}
class Derived extends Base {
  put(x: string) {
    super.store(x);
  }
}
const d = new Derived();
d.put(secret);
const out = await agent("reader").ask<string>(`use ${d.v}`);
return out;
