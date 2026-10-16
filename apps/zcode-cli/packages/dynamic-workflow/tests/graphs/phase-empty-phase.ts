// A phase that issues no step. Its marker is still a position control passes through, so the
// CFG's phase quotient shows "prepare" between the two steps, while the causality quotient —
// which knows phases only by their member steps — does not list it at all.
phase("scan");
const scan = await agent("scanner").ask<string>("scan");
phase("prepare");
const target = scan.trim();
phase("act");
return agent("actor").ask<string>(`act on ${target}`);
