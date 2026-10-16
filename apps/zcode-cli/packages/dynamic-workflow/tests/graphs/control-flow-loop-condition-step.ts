// KNOWN APPROXIMATION (docs/analysis.md, "The control-flow graph"): the walk
// evaluates a `while` condition once, before the loop region, so a step issued inside the
// condition sits OUTSIDE the loop on the CFG and appears to run once. Pinned here so a
// future `head` sub-region shows up as a deliberate golden change, not a surprise.
let rounds = 0;
while ((await agent("gate").ask<string>(`continue? round ${rounds}`)) === "yes") {
  await agent("worker").ask<string>(`work round ${rounds}`);
  rounds += 1;
}
return rounds;
