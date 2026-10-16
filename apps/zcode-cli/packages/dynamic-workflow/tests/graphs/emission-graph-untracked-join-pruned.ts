// A Promise.all over untracked string literals whose result is DISCARDED: the join
// ends with no incident edges and must be pruned from the site graph. The unrelated
// ask keeps the graph nonempty: source -> ask#1 -> sink; no join node at all.
await Promise.all(["a", "b"]);
return agent("solo").ask<string>("done");
