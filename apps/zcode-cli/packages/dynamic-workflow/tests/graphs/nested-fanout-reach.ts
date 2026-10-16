// Reachability across nested regions (fix #2). `deepen` asks; `viaMap` maps with a
// callback that CALLS `deepen` (not asks directly) — so the ask never marks
// `fn@viaMap` reachable via the facade, only the propagated call graph can. The
// top-level `seeds.map(...)` callback calls `viaMap`. Because a call is now recorded
// against EVERY enclosing region (not just the innermost `cand@N`), `fn@viaMap`
// becomes reachable through `deepen`, so BOTH iteration candidates promote to
// fan-out nodes: fan-out#1 = the `map` inside `viaMap` (source-order first),
// fan-out#2 = the top-level `seeds.map`. Before the fix the top-level map failed to
// promote (a dropped fan-out).
//
// Expected edges:
//   source -> world-read#1                       (glob drives the loops)
//   world-read#1 -> fan-out#2                     (seeds iterated by the top map)
//   world-read#1 -> fan-out#1, fan-out#2 -> fan-out#1  (the top element [s] is what
//                                                  viaMap's inner map iterates)
//   world-read#1 -> ask#1, fan-out#1 -> ask#1, fan-out#2 -> ask#1  (element into ask)
//   world-read#1 -> sink, fan-out#1 -> sink, fan-out#2 -> sink, ask#1 -> sink
const seeds = await files.glob("*.md");
function deepen(topic: string): Node<string> {
  return agent("worker").ask<string>(topic);
}
function viaMap(topics: string[]): Node<string>[] {
  return topics.map((t) => deepen(t));
}
const out = seeds.map((s) => viaMap([s]));
return out;
