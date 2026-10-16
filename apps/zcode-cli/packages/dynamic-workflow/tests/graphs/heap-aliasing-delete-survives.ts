// `delete` is gen-only: no kill. On the non-deleting path box.f still carries
// ask#1's output into the reader, so the edge must survive the maybe-delete.
// Expected: ask#1 -> ask#2 data; ask#2 -> sink.
const box: { f?: string } = {};
box.f = await agent("writer").ask<string>("secret");
if (Math.random() > 0.5) delete box.f;
return agent("reader").ask<string>(`use ${box.f ?? ""}`);
