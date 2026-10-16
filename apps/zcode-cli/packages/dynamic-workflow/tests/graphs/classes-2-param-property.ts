// A constructor PARAMETER PROPERTY (`constructor(private x: string) {}`) performs an
// implicit `this.x = x` at runtime; reveal() then returns it into ask#2.
// Probe: parameter properties are not PropertyDeclarations and the ctor body is empty —
// is the implicit assignment modeled?
// Expected: source -> ask#1, ask#1 -> ask#2 (ctor param property -> this.x), ask#2 -> sink.
const secret = await agent("writer").ask<string>("secret");
class Holder {
  constructor(private x: string) {}
  reveal(): string {
    return this.x;
  }
}
const h = new Holder(secret);
const out = await agent("reader").ask<string>(`use ${h.reveal()}`);
return out;
