// Overlapping, not nested: A's work is joined before C is entered, B's only before D. The
// live intervals are A ∥ B, B ∥ C, and A → C — the shape a timeline must colour onto two
// tracks, because no single band holds all three.
//
// Expected:
//   cfg — `phase phase#2 "B" alongside=phase#1` (B entered while A ran),
//     `phase phase#3 "C" alongside=phase#2` (C entered while B still ran), and phase#4 with
//     NO alongside: both fan-outs were joined by then. A's asks land on C's marker
//     (`ask#1@1 -> phase#3@1 join via=return`) and B's on D's
//     (`ask#2@1 -> phase#4@1 join via=return`), because a strand's exits reconnect at the
//     barrier that joins it and flow on to the next node.
//   causality — no edge between ask#1 and ask#2, and no forward `phase#1 -> phase#2` edge:
//     A and B are incomparable, which is what makes `alongside` and the quotient agree.
const ids = [1, 2];

phase("A");
const aWork = ids.map(async (i) => {
  const r = await agent(`a-${i}`).ask<string>(`survey ${i}`);
  return r;
});

phase("B");
const bWork = ids.map(async (i) => {
  const r = await agent(`b-${i}`).ask<string>(`probe ${i}`);
  return r;
});

const a = await Promise.all(aWork);

phase("C");
const c = await agent("c").ask<string>(`compare ${a.join(",")}`);
const b = await Promise.all(bWork);

phase("D");
const d = await agent("d").ask<string>(`${c} + ${b.join(",")}`);
return d;
