// Cyclic structure: `a.self = a` makes the abstract value genuinely cyclic. The
// write through a.self!.self! lands on `a` itself; convergence AND flow must hold.
// Expected: no crash; ask#1 -> ask#2 data; ask#2 -> sink.
interface Rec {
  f: string;
  self?: Rec;
}
const a: Rec = { f: "" };
a.self = a;
a.self!.self!.f = await agent("writer").ask<string>("secret");
return agent("reader").ask<string>(`use ${a.f}`);
