// The ABSENT-DOMINATES merge rule, pinned. When several facts hold for one ordered pair
// and any of them carries no phase provenance, the merged fact carries none and its edge
// fans out to every ADMISSIBLE copy of the head. Without this fixture an inverted branch
// stays green across the whole corpus, because nothing else has a pair carrying both a
// provenanced barrier fact and an unprovenanced one.
//
// The shape is chosen so that temporal admission cannot be what decides the outcome. The
// scout's ask is ISSUED before both `probe` calls (so both copies are admissible for the
// data edge — both issue after it), but it is not AWAITED until `audit` (so the barrier it
// raises is witnessed in `audit` alone). Absent-dominates is then the only rule left that
// can decide whether the merged data+seq fact reaches the `survey` copy:
//
//   ask#1 -> world-read#1~phase#1  and  -> world-read#1~phase#2
//     data (target feeds the git args, no provenance) merged with a seq barrier witnessed
//     only in `audit`. Absent dominates, so BOTH copies keep the edge. THIS PAIR PROVES
//     THE BRANCH: let the provenance survive the merge and `~phase#1` disappears.
//   ask#2 -> world-read#1~phase#2 ONLY
//     seq alone, so provenance narrows it — the contrast that makes the first pair mean
//     something.
//
// Why narrowing data would be WRONG, not merely stricter: the barrier's witness phase
// answers "where did an await order these two", and the data fact answers "whose argument
// carried whose answer". Different questions about the same pair, so one's witness cannot
// bound the other's reach. Admission is the rule that answers the temporal question, and
// it is applied separately.
//
// `world-read#1~phase#1 -> ask#2` is the other half worth reading: the tail is a copy too,
// and admission drops the `~phase#2` alternative because the audit copy is issued after
// ask#2, so it cannot precede it.

/** The shared helper: one world-read site, called from two phases. */
async function probe(hint: string): Promise<string> {
  const log = await world.run("git", ["log", "-1", "--format=%s", "--grep", hint]);
  return log.stdout.trim();
}

phase("survey");
const scout = agent("scout");
const auditor = agent("auditor");
// Issued here, awaited in `audit`: the promise crosses the marker, the step does not.
const pending = scout.ask<string>("Name one commit subject worth auditing.");
const baseline = await probe("release");

phase("audit");
const target = await pending;
const note = await auditor.ask<string>("Anything to watch for in this repo?");
const latest = await probe(target);
return { baseline, latest, note };
