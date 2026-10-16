// Mutual recursion: taint enters even(), threads through odd() and back, and exits
// via the base-case ask. The summary fixpoint must carry seed across the cycle.
// Expected: ask#2 (seed) -> ask#1 (final) data; ask#1 -> sink data.
const judge = agent("judge");
async function even(s: string, n: number): Promise<string> {
  if (n <= 0) return await judge.ask<string>(`final ${s}`);
  return odd(s, n - 1);
}
async function odd(s: string, n: number): Promise<string> {
  return even(s, n - 1);
}
const seed = await agent("s").ask<string>("seed");
const out = await even(seed, 4);
return out;
