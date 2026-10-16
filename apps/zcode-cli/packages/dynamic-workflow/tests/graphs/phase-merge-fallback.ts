// Two things at once: the same name at two call sites is ONE phase — the name is the key,
// unlike an actor's name, which is only a display label — and the steps issued before the
// script's first marker fall into the synthetic `unphased` phase, which sorts first.

const reviewer = agent("reviewer");

// No marker is current yet, so this read is `unphased` — the fallback exists for exactly
// this shape (a script whose author marked the interesting middle and not the setup).
const paths = await files.glob("src/**/*.ts");

if (paths.length > 1) {
  phase("gate");
  const body = await files.read(paths[0] ?? "src/index.ts");
  const verdict = await reviewer.ask<string>(`Review:\n${body}`);
  report({ verdict });
} else {
  // Second call site, same word: one phase#1, not a phase#2.
  phase("gate");
  const readme = await files.read("README.md");
  const verdict = await reviewer.ask<string>(`Review:\n${readme}`);
  report({ verdict });
}

return paths.length;
