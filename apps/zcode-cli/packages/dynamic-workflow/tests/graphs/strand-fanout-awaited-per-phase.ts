// The control for strand-fanout-two-phases-join: the same three fan-outs, but each phase
// awaits its own work before the next marker. This script really is sequential, and the two
// fixtures' goldens must DIFFER — under the old single settled set they were byte-identical,
// which is what made the defect invisible to every downstream view.
//
// Expected:
//   core — the same `strand` flags on the three fan-out regions, but two separate barriers:
//     `settle ask#1 in=seq#1 joins=fanout#1` before B's marker and
//     `settle ask#2 in=seq#1 joins=fanout#2` before C's.
//   causality — `ask#1 -> ask#2 seq` and `phase#1 -> phase#2 seq` survive: A's answers were
//     awaited before B issued, so the ordering is real and the arrow is earned.
//   cfg — NO `alongside` on any mark or phase line, because nothing was ever parked across
//     a marker; A's exits join at B's mark and B's at C's.
const ids = [1, 2, 3];

phase("A");
const aWork = ids.map(async (i) => {
  const r = await agent(`a-${i}`).ask<string>(`survey ${i}`);
  return r;
});
const a = await Promise.all(aWork);

phase("B");
const bWork = ids.map(async (i) => {
  const r = await agent(`b-${i}`).ask<string>(`probe ${i}`);
  return r;
});
const b = await Promise.all(bWork);

phase("C");
const merged = await Promise.all(
  ids.map(async (i) => {
    const r = await agent(`c-${i}`).ask<string>(`${a.join(",")} / ${b.join(",")} #${i}`);
    return r;
  }),
);
return merged;
