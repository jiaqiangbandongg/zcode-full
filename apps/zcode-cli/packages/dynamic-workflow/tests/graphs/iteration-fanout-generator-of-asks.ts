// A generator yielding ASK NODES (not strings), consumed by for...of whose body only
// awaits and collects (no facade call in the body -> the for...of must NOT promote).
// The yields join the generator's summary, so jobs(s) carries ask#1/ask#2; awaiting
// the elements and pushing into results routes both into ask#3's instructions.
// Expected: source -> world-read#1; world-read#1 -> ask#1, world-read#1 -> ask#2;
//           ask#1 -> ask#3, ask#2 -> ask#3 (MUST); ask#3 -> sink; NO fan-out node.
function* jobs(seed: string): Generator<Node<string>> {
  yield agent("a").ask<string>(`one ${seed}`);
  yield agent("b").ask<string>(`two ${seed}`);
}
const s = await files.read("seed.txt");
const results: string[] = [];
for (const job of jobs(s)) {
  results.push(await job);
}
return agent("c").ask<string>(results.join(","));
