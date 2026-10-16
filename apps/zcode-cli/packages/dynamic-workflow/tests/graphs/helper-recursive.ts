// Self-recursive helper carrying a tracked value down to a base-case ask. The
// fixpoint must terminate; the seed's taint must reach the digger ask through the
// recursive parameter. ask#1 (digger) is declared before ask#2 (seeder) in source
// order. Expected: source -> ask#2, ask#2 -> ask#1 (seed reaches digger via `seed`),
// ask#1 -> sink (the returned artifact), all exact.
async function dig(n: number, seed: string): Promise<string> {
  if (n <= 0) return await agent("digger").ask<string>(`base ${seed}`);
  return dig(n - 1, seed);
}

const s = await agent("seeder").ask<string>("seed");
const out = await dig(3, s);
return out;
