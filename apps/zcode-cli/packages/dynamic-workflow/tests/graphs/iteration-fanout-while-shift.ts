// while-loop consuming a tracked array with .shift(): shift is an unknown call, so
// its result is the receiver's collapse — the element taint must survive into the
// ask after the loop. No fan-out (while is control structure, renders as a cycle).
// Expected: source -> world-read#1; world-read#1 -> ask#1 (MUST); ask#1 -> sink;
//           NO fan-out node.
const queue = await files.glob("*.md");
const notes: string[] = [];
while (queue.length > 0) {
  const item = queue.shift();
  if (item !== undefined) {
    notes.push(item);
  }
}
return agent("summarizer").ask<string>(notes.join(","));
