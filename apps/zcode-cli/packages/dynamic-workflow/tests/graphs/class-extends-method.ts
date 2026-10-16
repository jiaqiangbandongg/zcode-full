// A derived class with no constructor inherits the base constructor (implicit super
// forwards the argument) and the base method; both dispatch through the shared derived
// instance (extends weak-merges the base instance in). Expected: source -> ask#1,
// ask#1 -> ask#2, ask#2 -> sink.
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
class Derived extends Base {}
const d = new Derived(secret);
const out = await agent("reader").ask<string>(`use ${d.reveal()}`);
return out;
