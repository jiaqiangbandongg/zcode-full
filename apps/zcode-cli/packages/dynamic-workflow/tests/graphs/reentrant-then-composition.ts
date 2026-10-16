// Positive guard (already holds): a callback passed to unknown `.then` whose body calls
// another unknown `.then` with a further callback (reentrant HOF composition). The inner
// editor ask receives the outer draft via captured-parameter placeholder resolution.
// Expected: source -> ask#1 (writer), ask#1 -> ask#2 (editor, INEXACT via the unknown-call
// keystone widening), ask#2 -> sink.
const draft = agent("writer").ask<string>("draft");
const out = await draft.then((text) =>
  Promise.resolve(text).then((inner) => agent("editor").ask<string>(`edit ${inner}`)),
);
return out;
