// `new` inside a fan-out body: one Judge instance per element, all conflated into the
// class's single abstract instance. Element taint enters through the ctor param
// (this.item = x) and the per-element ask must see both the producer and the fan-out.
// Expected: source -> ask#1; ask#1 -> fan-out#1; ask#1 -> ask#2 and fan-out#1 -> ask#2
// (via this.item); ask#2 -> join#1 (and ask#1/fan-out#1 -> join#1, additive relay);
// join#1 -> sink and ask#2 -> sink (return derives from the joined verdicts).
const list = await agent("planner").ask<string[]>("list items");
class Judge {
  item: string;
  constructor(x: string) {
    this.item = x;
  }
  go(): Node<string> {
    return agent("judge").ask<string>(`judge ${this.item}`);
  }
}
const verdicts = await Promise.all(list.map((it) => new Judge(it).go()));
return verdicts.join(",");
