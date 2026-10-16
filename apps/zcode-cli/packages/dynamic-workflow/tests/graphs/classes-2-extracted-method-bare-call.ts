// A method extracted off an instance and called BARE (const m = r.run; m("go")). The
// call loses runtime `this` binding semantics, but the analysis resolves `this`
// lexically to the shared instance, so the this-dependent flow (this.base = ask#1's
// artifact) must survive into ask#2. (Runtime: bare `this` is undefined and would
// throw, but under the analysis's conflated-instance model the flow is the may-flow
// of the .call/.bind family — the graph must keep it.)
// Expected: source -> ask#1, ask#1 -> ask#2 (via this.base), ask#2 -> sink.
const prompt = await agent("writer").ask<string>("prompt");
class Runner {
  base = prompt;
  run(x: string): Node<string> {
    return agent("reader").ask<string>(`${this.base}: ${x}`);
  }
}
const r = new Runner();
const m = r.run;
const out = await m("go");
return out;
