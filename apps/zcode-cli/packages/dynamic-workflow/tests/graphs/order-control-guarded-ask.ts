// `if (result) …` guarding a later ask: a `control` edge from the tested step into the
// guarded one, and the guarded step's certainty drops to `maybe`.
const triage = await agent("triage").ask<{ escalate: boolean }>("triage this");
if (triage.escalate) {
  const senior = await agent("senior").ask<string>("handle escalation");
  return senior;
}
return "no escalation";
