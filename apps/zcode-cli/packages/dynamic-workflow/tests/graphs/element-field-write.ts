// Element-field write (heap fix): a tainted field written through an element-access
// receiver (`arr[0]!.f = secret`), then read back through the same static index. The
// write resolves arr[0] to its live field object, so the precise read sees the secret.
// Expected: source -> ask#1, ask#1 -> ask#2, ask#2 -> sink.
const secret = await agent("writer").ask<string>("secret");
const arr = [{ f: "" }];
arr[0]!.f = secret;
const out = await agent("reader").ask<string>(`use ${arr[0]!.f}`);
return out;
