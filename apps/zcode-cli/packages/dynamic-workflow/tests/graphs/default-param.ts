// Default parameter initializer referencing tainted outer state must be evaluated:
// build() with no argument takes prefix = s (ask#1), which flows into ask#2.
const s = await agent("s").ask<string>("seed");
function build(prefix: string = s): string {
  return `built ${prefix}`;
}
const r = build();
const b = await agent("b").ask<string>(`use ${r}`);
return b;
