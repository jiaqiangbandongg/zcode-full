// A derived method (under a DIFFERENT name, so merged-field dispatch cannot mask it)
// returns super.reveal(). At runtime super.reveal() returns this.data (= secret), so
// secret flows into ask#2. Probe: does `super.m()` dispatch to the base method summary?
// Expected: source -> ask#1, ask#1 -> ask#2 (via super.reveal()), ask#2 -> sink.
const secret = await agent("writer").ask<string>("secret");
class Base {
  data: string;
  constructor(s: string) {
    this.data = s;
  }
  reveal(): string {
    return this.data;
  }
}
class Derived extends Base {
  expose(): string {
    return super.reveal();
  }
}
const d = new Derived(secret);
const out = await agent("reader").ask<string>(`use ${d.expose()}`);
return out;
