// A guard that reads a value DERIVED from an ask. `const ok = t.escalate` issues nothing,
// so phase 1's syntactic controller map — which records the steps issued while evaluating
// an initializer — associates no step with `ok`, and the guard produced no `control` edge
// at all. The phase-2 taint oracle carries ask#1's label through the field read into the
// guard's value, so `ask#1 -control-> ask#2` appears (see docs/analysis.md,
// "Control dependence").
const t = await agent("triage").ask<{ escalate: boolean }>("triage");
const ok = t.escalate;
if (ok) {
  return await agent("senior").ask<string>("handle");
}
return "no escalation";
