// A `return` inside a helper targets the helper's `call` region, not the script's root: the
// early return skips the helper's second step and lands back at the CALL SITE. The helper is
// called twice, so the CFG has two occurrences of each of its steps, one per call.
async function triage(input: string): Promise<string> {
  const first = await agent("triage").ask<string>(`first look: ${input}`);
  if (first.length < 3) return first;
  return agent("deep").ask<string>(`deep look: ${first}`);
}

const a = await triage("alpha");
const b = await triage("beta");
return { a, b };
