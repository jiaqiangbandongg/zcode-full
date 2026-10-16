// A facade call inside a class field initializer must be evaluated (the initializer runs
// at construction). The instance carries the artifact; reading the field surfaces it.
// Expected: source -> ask#1, ask#1 -> ask#2, ask#2 -> sink.
const seed = await agent("a").ask<string>("seed");
class C {
  field = agent("b").ask<string>(seed);
}
const c = new C();
return await c.field;
