// Rest-of-block scope, all three of its edges at once: a marker inside an if-block does
// not leak past the block, a marker at a block's tail claims nothing, and the enclosing
// phase resumes the moment the inner block ends.

phase("survey");
const paths = await files.glob("src/**/*.ts");
const auditor = agent("auditor");
const scribe = agent("scribe");

if (paths.length > 0) {
  phase("audit");
  const body = await files.read(paths[0] ?? "src/index.ts");
  const verdict = await auditor.ask<string>(`Audit:\n${body}`);
  report({ verdict });
  // Last statement of its block, so it claims nothing: legal, harmless, undiagnosed. It
  // still MINTS phase#3 (first reach numbers the ids), and the projection then drops it
  // for having no members — which is why the phase list below jumps to phase#4.
  phase("dead-tail");
}

// `survey` is current again here: this read belongs to it, not to `audit`.
const readme = await files.read("README.md");

phase("wrap");
const summary = await scribe.ask<string>(`Summarize ${paths.length} files:\n${readme}`);
return summary;
