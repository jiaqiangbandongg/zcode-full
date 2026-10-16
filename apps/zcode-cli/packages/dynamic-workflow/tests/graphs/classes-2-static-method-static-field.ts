// A static method called via the class name asks with a static field (read through
// `this`, which in a static method is the class). Static and instance state conflate
// into one abstract instance, so the static-field taint must reach ask#2.
// Expected: source -> ask#1, ask#1 -> ask#2, ask#2 -> sink.
const seed = await agent("a").ask<string>("seed");
class Cfg {
  static prompt = seed;
  static run(): Node<string> {
    return agent("b").ask<string>(`go ${this.prompt}`);
  }
}
const out = await Cfg.run();
return out;
