// A method declared with a COMPUTED name (["run"]) but called through the plain static
// name w.run(secret). Runtime: the method executes, ask#2 receives `use ${secret}`, and
// its Node is returned to the sink. Probe: computed-name members are skipped by the
// class-body registration — does the method still dispatch?
// Expected: source -> ask#1, ask#1 -> ask#2 (param x), ask#2 -> sink.
const secret = await agent("writer").ask<string>("secret");
class Worker {
  ["run"](x: string): Node<string> {
    return agent("reader").ask<string>(`use ${x}`);
  }
}
const w = new Worker();
const out = await w.run(secret);
return out;
