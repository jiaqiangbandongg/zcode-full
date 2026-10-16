// Fan-out ordinal stability: the FIRST iteration candidate (.map with no facade sites
// in its body) is NOT promoted; the later for...of (which asks) is. The promoted
// candidate must be fan-out#1 (ordinals count promoted candidates, not candidates),
// with source -> fan-out#1 (untracked collection), fan-out#1 -> ask#1 (element in the
// instructions), ask#1 -> sink, and actor#1 carrying within=fan-out#1 (lane family).
const names = ["alpha", "beta"];
const sizes = names.map((n) => n.length);
log(`sizes ${sizes.join(",")}`);
const outs: string[] = [];
for (const n of names) {
  outs.push(await agent("w").ask<string>(`work on ${n}`));
}
return outs.join(",");
