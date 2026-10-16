// Extracted-alias (heap fix): a sub-object pulled out of a container by an aliasing
// binding (`const b = arr[0]`) stays the SAME object as `arr[0]`, so `b.f = secret` is
// visible through `arr[0].f`. Confirms aliasing reaches through element extraction.
// Expected: source -> ask#1, ask#1 -> ask#2, ask#2 -> sink.
const secret = await agent("writer").ask<string>("secret");
const arr = [{ f: "" }];
const b = arr[0]!;
b.f = secret;
const out = await agent("reader").ask<string>(`use ${arr[0]!.f}`);
return out;
