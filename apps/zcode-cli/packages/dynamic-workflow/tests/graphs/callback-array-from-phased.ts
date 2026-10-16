// Callback invocation family: `Array.from(xs, fn)` with an inline mapper inside a phase, next
// to a `flatMap` that was always a candidate. Both are `each` entries of the registry, so
// both are fan-out candidates and the fixer's ask is a phase#2 member.
phase("triage");
const paths = await files.glob("src/**/*.ts");
const flagged = await Promise.all(paths.flatMap((p) => [agent(`t-${p}`).ask<string>(`triage ${p}`)]));
const picked = flagged.filter((f) => f.length > 0);
phase("fix");
const fixes = await Promise.all(Array.from(picked, (f) => agent("fixer").ask<string>(`fix ${f}`)));
return fixes;
