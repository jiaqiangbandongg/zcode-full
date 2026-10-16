// for...of over .entries() of a tainted array, destructured [i, v]: entries() is an
// unknown call (collapse of the receiver keeps world-read#1), the loop body asks, so
// the for...of promotes; v (and i, over-approximated) carry the glob taint.
// Expected: source -> world-read#1; world-read#1 -> fan-out#1;
//           world-read#1 -> ask#1; fan-out#1 -> ask#1; source completion none else.
const seeds = await files.glob("*.md");
for (const [i, v] of seeds.entries()) {
  await agent("worker").ask<string>(`${i}: ${v}`);
}
return "done";
