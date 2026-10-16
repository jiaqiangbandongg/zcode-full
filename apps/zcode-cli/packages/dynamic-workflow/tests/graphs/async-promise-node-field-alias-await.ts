// A Node<T> stored in an object field after creation, awaited later through a
// DIFFERENT alias of the container.
// Expected: ask#1 -> ask#2 data; ask#2 -> sink.
const box: { pending?: Node<string> } = {};
box.pending = agent("writer").ask<string>("draft");
const alias = box;
const text = await alias.pending!;
return agent("editor").ask<string>(`edit ${text}`);
