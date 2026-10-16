// Generator yields tainted values, consumed by for...of. The yielded operand must
// enter the generator's return summary so `pieces(s)` carries s's taint into the
// fan-out and the per-element worker ask.
function* pieces(seed: string): Generator<string> {
  yield `${seed}-a`;
  yield `${seed}-b`;
}
const s = await agent("s").ask<string>("seed");
for (const item of pieces(s)) {
  await agent("worker").ask<string>(`process ${item}`);
}
return "done";
