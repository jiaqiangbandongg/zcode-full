// Promise.race / Promise.any are NOT join-listed: they must fall to the
// unknown-call rule and still carry every input's taint (no join nodes appear).
// Expected: ask#1 -> ask#4; ask#2 -> ask#4; ask#3 -> ask#4 (all data);
//   ask#4 -> sink; NO join nodes.
const a = agent("alpha").ask<string>("fast");
const b = agent("beta").ask<string>("slow");
const winner = await Promise.race([a, b]);
const c = agent("gamma").ask<string>("alt");
const anyWinner = await Promise.any([b, c]);
return agent("judge").ask<string>(`compare ${winner} vs ${anyWinner}`);
