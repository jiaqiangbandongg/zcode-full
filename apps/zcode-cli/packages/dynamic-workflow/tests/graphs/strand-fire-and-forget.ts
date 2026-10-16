// A fan-out nobody ever awaits: the script starts A's subagents, walks on to B, and returns
// without joining them. Nothing in the script orders A's work against B's, so nothing may be
// claimed — the only fact left is that the run outlived the strand.
//
// Expected:
//   causality — NO edge between ask#1 (the fan-out's) and ask#2 (B's).
//   cfg — `ask#1@1 -> sink join` (no `via`: the callback falls out of its body rather than
//     returning a value). Strands still parked when the root body ends are drained into the
//     sink, which is where "the script outlived it" is written down. And
//     `phase phase#2 "B" alongside=phase#1`, since A's strand was live at B's marker.
const ids = [1, 2, 3];

phase("A");
ids.map(async (i) => {
  await agent(`a-${i}`).ask<string>(`background ${i}`);
});

phase("B");
return await agent("b").ask<string>("b");
