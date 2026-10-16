// Write through a static index of a BOUND Promise.all result, read back through the
// ORIGINAL variable that was passed as that join element. Runtime: res[1] === box, so
// `res[1].note = res[0]` makes box.note carry ask#1's output; ask#2 reads box.note.
// Required may-flow: ask#1 -> ask#2. (The shipped fixture
// tests/graphs/join-element-alias-write-through.ts writes AND reads through res[k];
// this probes the other direction: write via the join result, read via the source.)
// The graph also carries SOUND additive over-approximations: res[0] is a join output, so
// writing it into box gives box the join#1 label AND ask#1; box is itself join input port 1
// (flow-insensitively), producing `ask#1 -> join#1 port=1`, a `join#1 -> join#1 port=1`
// self-loop, and `join#1 -> ask#2` — all inexact, over-approximations rather than drops.
interface Box {
  note: string;
}
const box: Box = { note: "plain" };
const secret = agent("spy").ask<string>("fetch");
const res = await Promise.all([secret, box]);
res[1].note = res[0];
return agent("reader").ask<string>(`report on ${box.note}`);
