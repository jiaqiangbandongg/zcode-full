// Cross-instance conflation (sound-by-design over-approximation, per spec residual 6):
// one instance's ctor stores the secret; a DIFFERENT instance is read into ask#2. At
// runtime clean.v is "clean", but all instances of a class conflate into one abstract
// instance, so the analyzer SHOULD emit ask#1 -> ask#2 anyway. This is a regression
// test that the deliberate over-approx edge is present (its absence would signal the
// conflation model broke).
// Expected: source -> ask#1, ask#1 -> ask#2 (conflated instances), ask#2 -> sink.
const secret = await agent("writer").ask<string>("secret");
class Box {
  v: string;
  constructor(x: string) {
    this.v = x;
  }
}
new Box(secret);
const clean = new Box("clean");
const out = await agent("reader").ask<string>(`use ${clean.v}`);
return out;
