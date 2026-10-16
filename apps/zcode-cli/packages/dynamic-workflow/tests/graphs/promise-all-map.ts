// Fan-out (.map bound to a variable) feeding a NON-literal Promise.all join feeding
// an aggregator ask, seeded from files.glob. Because the join argument is a variable
// (not a static array literal) its edges are portless. Relay labels are additive, so
// the merger ask sees both the join and the per-element drafter directly.
// Expected: world-read#1 -> fan-out#1 -> ask#1(drafter, within=fan-out#1) -> join#1,
// then join#1 -> ask#2(merger) and ask#1 -> ask#2 (additive), ask#2 -> sink.
const files_ = await files.glob("*.md");
const drafts = await Promise.all(
  files_.map((f) => agent("drafter").ask<string>(`draft from ${f}`)),
);
const merged = await agent("merger").ask<string>(`merge: ${drafts.join("\n")}`);
return merged;
