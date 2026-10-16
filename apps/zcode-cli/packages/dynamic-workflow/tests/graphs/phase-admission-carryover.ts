// The REPETITION CARVE-OUT in the phase copies' temporal admission, pinned.
//
// Admission normally asks "does some issue of the head in its phase sit after the first
// issue of the tail in its phase". Inside a loop that question has a second answer: the
// two sites share an enclosing iteration region, so iteration k's producer really does
// feed iteration k+1's consumer even though the consumer's position is EARLIER. The
// carve-out is what admits that, and it is mirrored from `realizableCarry` rather than
// re-derived — one relation, one answer.
//
// Here the shared `probe` site is claimed by `open` (position first in every round) and by
// `close`; the scout's pick, issued in `close`, is what the NEXT round's `open` probe reads
// through `hint`. So:
//
//   ask#1 -> world-read#1~phase#1   SURVIVES ONLY VIA THE CARVE-OUT — the open copy is
//     issued before ask#1 in walk order, and drop the shared-iteration clause and this
//     edge dies, taking a real loop-carried data dependency with it and leaving the two
//     phases looking concurrent. That is inventing concurrency, the one direction the
//     analysis may never take.
//   ask#1 -> world-read#1~phase#2   admitted by position, the ordinary case.

/** The shared helper: one world-read site, called from both phases of every round. */
async function probe(hint: string): Promise<string> {
  const log = await world.run("git", ["log", "-1", "--format=%s", "--grep", hint]);
  return log.stdout.trim();
}

const scout = agent("scout");
let hint = "initial";
let summary = "";
for (let round = 0; round < 3; round++) {
  phase("open");
  // Reads what the PREVIOUS round's `close` picked — the loop-carried edge under test.
  const opening = await probe(hint);

  phase("close");
  const pick = await scout.ask<string>(`Given "${opening}", name the next commit to read.`);
  summary = await probe(pick);
  hint = pick;
}
return summary;
