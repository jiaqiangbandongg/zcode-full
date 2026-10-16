// Destructure a Promise.all result, then WRITE through one destructured element.
// Runtime: Promise.all resolves the non-promise element to the object itself, so
// `alias` IS `box`; `alias.note = sec` puts ask#1's output into box.note, which
// ask#2 then reads. Required may-flow: ask#1 -> ask#2.
// The graph also carries SOUND additive over-approximations: `sec` (= res[0]) is a join
// output, so writing it into `box.note` gives box the join#1 label AND ask#1; since box is
// itself join input port 1 (flow-insensitively), that produces `ask#1 -> join#1 port=1`, a
// `join#1 -> join#1 port=1` self-loop, and `join#1 -> ask#2`. All inexact (may-alias replay
// + flow-insensitive conflation) — over-approximations, never dropped flows.
interface Box {
  note: string;
}
const box: Box = { note: "plain" };
const secret = agent("spy").ask<string>("fetch the secret");
const [sec, alias] = await Promise.all([secret, box]);
alias.note = sec;
return agent("reader").ask<string>(`report on ${box.note}`);
