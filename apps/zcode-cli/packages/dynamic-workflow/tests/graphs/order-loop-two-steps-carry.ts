// A TWO-step loop whose body output feeds the next round: the `carry` edge closes a
// cycle BETWEEN the two steps (writer -> editor -> writer) and neither gets a
// self-arrow. Contrast control-flow-do-while-self-loop.ts, the single-step case.
const writer = agent("writer");
const editor = agent("editor");
let notes = "none";
for (let round = 0; round < 3; round++) {
  const draft = await writer.ask<string>(`write, notes: ${notes}`);
  notes = await editor.ask<string>(`edit ${draft}`);
}
return notes;
