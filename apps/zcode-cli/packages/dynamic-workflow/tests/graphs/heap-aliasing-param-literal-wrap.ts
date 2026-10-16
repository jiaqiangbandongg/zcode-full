// The callee writes through a SUB-OBJECT of its parameter; the caller's argument is
// a literal wrapping the live box, so at runtime p.box === box and box.f receives
// ask#1's output on every execution.
// Expected: ask#1 -> ask#2 data; ask#2 -> sink.
const box: { f: string } = { f: "" };
async function poke(p: { box: { f: string } }): Promise<void> {
  p.box.f = await agent("writer").ask<string>("secret");
}
await poke({ box });
return agent("reader").ask<string>(`use ${box.f}`);
