// A facade call inside a static block runs at class initialization. Static and instance
// members conflate into one abstract instance, so the static field read connects a -> b.
// Expected: source -> ask#1, ask#1 -> ask#2, ask#2 -> sink.
const seed = await agent("a").ask<string>("seed");
class Registry {
  static value: Node<string>;
  static {
    this.value = agent("b").ask<string>(`process ${seed}`);
  }
}
return await Registry.value;
