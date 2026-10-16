// A shared helper issued BEFORE the loop (baseline) and INSIDE it (gate): under the
// phase-1 one-step-per-site rule both occurrences quotient onto world-read#1, so
// read -> ask (baseline feeds the first prompt) and ask -> read (the gate re-runs the
// helper after every ask) are BOTH forward facts — a residual 2-cycle no carry lift
// removes. Regression guard for the reducer: on this shape the old
// batch-remove-then-restore pass over-restored (the jsonl-db symptom: 66 forward
// edges, 55 of them implied by the rest); the reduction must stay irredundant here.
async function bench(): Promise<string> {
  const result = await world.run("./bench", []);
  return result.stdout;
}
const optimizer = agent("optimizer");
let best = await bench();
for (let round = 0; round < 3; round++) {
  const idea = await optimizer.ask<string>(`beat this baseline: ${best}`);
  await world.run("cargo", ["test", idea]);
  best = await bench();
}
return best;
