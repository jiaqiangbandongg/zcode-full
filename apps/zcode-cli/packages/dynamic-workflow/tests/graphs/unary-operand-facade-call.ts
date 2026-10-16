// A facade call inside a void/typeof/delete operand must still be evaluated (the operand
// runs at runtime). Fire-and-forget `void` idiom shown; typeof/delete share the gap and
// the same fix (they are distinct AST node kinds, not PrefixUnaryExpression).
// Expected: source -> ask#1, ask#1 -> ask#2 (seed into b's ask), ask#1 -> sink (return seed).
const seed = await agent("a").ask<string>("seed");
const b = agent("b");
void b.ask<string>(seed);
return seed;
