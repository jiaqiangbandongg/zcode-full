// Two names for one array: the ask is pushed through `ys`, the join reads `xs`.
// Expected: ask#1 -> join#1 data (portless); ask#1 -> ask#2 and join#1 -> ask#2
// (relay labels are additive); ask#2 -> sink.
const xs: Node<string>[] = [];
const ys = xs;
ys.push(agent("writer").ask<string>("draft"));
const parts = await Promise.all(xs);
return agent("reader").ask<string>(`use ${parts.join(" ")}`);
