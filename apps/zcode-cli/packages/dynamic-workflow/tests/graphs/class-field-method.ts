// A class instance carries taint through a constructor-stored field returned by a
// method. Sound today at whole-object granularity: the ask result flows into `new`,
// the instance carries it, and box.get() returns it into the reader ask.
// Expected: source -> ask#1, ask#1 -> ask#2, ask#2 -> sink.
class Box {
  x: string;
  constructor(v: string) {
    this.x = v;
  }
  get(): string {
    return this.x;
  }
}
const secret = await agent("writer").ask<string>("secret");
const box = new Box(secret);
const out = await agent("reader").ask<string>(`use ${box.get()}`);
return out;
