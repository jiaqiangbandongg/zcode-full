// Parameter write-back (heap fix): objects cross call boundaries by reference. `stash`
// writes a tainted value into a field of its `box` parameter; the write is merged back
// into the caller's argument, so the caller reads the secret through `box.f`.
// Expected: source -> ask#1, ask#1 -> ask#2 (secret via param write-back), ask#2 -> sink.
function stash(box: { f: string }, v: string): void {
  box.f = v;
}
const secret = await agent("writer").ask<string>("secret");
const box = { f: "" };
stash(box, secret);
const out = await agent("reader").ask<string>(`use ${box.f}`);
return out;
