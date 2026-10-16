// A facade ask in the KEY position of an element-access READ (`o[<ask>]`). Runtime: ask#1's
// output (s) is interpolated into ask#2's instructions (the key expression), so ask#1 -> ask#2
// is a required may-flow edge and ask#2 runs on the "picker" lane. The read RESULT does NOT
// carry the key's taint (the value stored at a key does not textually contain the key — the
// same convention as a ternary condition), so ask#3 reads a literal-only value. If the
// evaluator skips the key expression, ask#2 loses its instruction/receiver sinks entirely.
const s = await agent("keeper").ask<string>("secret");
const table: Record<string, string> = { a: "alpha", b: "beta" };
const picked = table[await agent("picker").ask<string>(`pick a key using ${s}`)];
return agent("final").ask<string>(`use ${picked ?? "none"}`);
