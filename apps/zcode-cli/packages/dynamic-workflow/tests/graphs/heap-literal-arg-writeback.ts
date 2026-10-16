// The callee writes a NEW field on its parameter and hands the object back; the caller's
// argument is an inline literal — storage with no name of its own. The note written through
// the parameter must be readable through the returned reference.
// Expected: ask#1 -> ask#2 data (through r.note); ask#2 -> sink.
// Convergence pin: while a literal was a per-pass fresh value this never converged — the
// parameter write-back landed on storage recreated every pass and re-reported a change forever
// (docs/analysis.md, "Convergence": literals are allocation-site places).
function tag(box: { name: string; note?: string }, t: string): { name: string; note?: string } {
  box.note = t;
  return box;
}
const t = await agent("writer").ask<string>("draft");
const r = tag({ name: "x" }, t);
return agent("reader").ask<string>(`use ${r.note}`);
