// Promise executor laundering: the value passed to resolve() IS the awaited value.
// Runtime: draft resolves -> p resolves to draft's output -> text -> editor ask.
// Expected: ask#1 -> ask#2 data; ask#2 -> sink.
const draft = agent("writer").ask<string>("write a draft");
const p = new Promise<string>((resolve) => {
  resolve(draft);
});
const text = await p;
return agent("editor").ask<string>(`edit: ${text}`);
