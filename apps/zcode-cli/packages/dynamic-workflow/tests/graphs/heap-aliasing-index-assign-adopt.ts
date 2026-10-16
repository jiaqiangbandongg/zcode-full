// Alias established through a container-field ASSIGNMENT (not a literal element):
// `slots[0] = box` must share the reference, so `slots[0].f = secret` mutates box.f.
// Expected: ask#1 -> ask#2 data; ask#2 -> sink.
const box: { f: string } = { f: "" };
const slots: { f: string }[] = [];
slots[0] = box;
slots[0]!.f = await agent("writer").ask<string>("secret");
return agent("reader").ask<string>(`use ${box.f}`);
