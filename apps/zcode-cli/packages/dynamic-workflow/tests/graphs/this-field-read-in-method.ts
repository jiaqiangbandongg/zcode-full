// Idiomatic OOP: the constructor stores an artifact in a field, a method reads this.field
// to build a new ask and returns it. Both the this-read edge and the method-return edge
// must survive. Expected: source -> ask#1, ask#1 -> ask#2, ask#2 -> sink.
const seed = await agent("a").ask<string>("seed");
class Pipeline {
  seed: string;
  constructor(v: string) {
    this.seed = v;
  }
  run() {
    return agent("b").ask<string>(`refine ${this.seed}`);
  }
}
return await new Pipeline(seed).run();
