// .then with BOTH callbacks plus a .finally in the chain: either callback's ask
// result becomes the settled value, and .finally passes it through.
// Expected: ask#1 -> ask#2 (draft into the fulfill callback, inexact ok);
//   ask#2 -> sink; ask#3 -> sink (both callbacks' results may settle the chain).
const draft = agent("writer").ask<string>("draft");
const settled = await Promise.resolve(draft)
  .then(
    (t) => agent("editor").ask<string>(`edit ${t}`),
    (e) => agent("fixer").ask<string>(`recover from ${String(e)}`),
  )
  .finally(() => log("done"));
return settled;
