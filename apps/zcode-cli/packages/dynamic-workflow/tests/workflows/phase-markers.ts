// phase() markers: presentation-only grouping, and every legal position for one.
// The marker's scope is the rest of its block, so a marker at the top of the script, one
// inside an if-block and one inside a loop body are all fine — and this file must compile
// clean, which is also the proof that the facade declares `phase(name: string): void`.
phase("preflight");
const paths = await files.glob("src/**/*.ts");
const reviewer = agent("reviewer");

if (paths.length > 0) {
  // Scoped to this branch only: the enclosing phase resumes after the if.
  phase("review");
  for (const path of paths) {
    phase("per-file");
    const body = await files.read(path);
    log(`reviewing ${path} (${body.length} bytes)`);
    const verdict = await reviewer.ask<string>(`Review:\n${body}`);
    report({ path, verdict });
  }
  // A marker as the last statement of its block claims nothing — legal, harmless, and
  // deliberately not a diagnostic (an effect-free marker is a stale edit, not an error).
  phase("nothing-follows");
}

// Same name twice is one phase — the name is the key, not the call site.
phase("wrap-up");
// A no-substitution template is a compile-time literal too.
phase(`wrap-up`);
return paths.length;
