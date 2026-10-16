// Phase markers erase: the sandbox has no `phase` binding to call, so every marker must
// lower to `void 0` — a leftover free identifier is a run-time ReferenceError. The markers
// here stand in every position that survives to the sandbox: script top, inside a block,
// and right before the return. Comments survive lowering, so this one deliberately avoids
// spelling the marker as a call: the suite greps the lowered text for one.
phase("preflight");
const paths = await files.glob("src/**/*.ts");
const reviewer = agent("reviewer");

if (paths.length > 0) {
  phase("review");
  const first = paths[0] ?? "src/index.ts";
  const verdict = await reviewer.ask<string>(`Review ${first}`);
  report({ first, verdict });
  log("reviewed");
}

phase("wrap-up");
return paths.length;
