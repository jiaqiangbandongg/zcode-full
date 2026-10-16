// Positive coverage: a returned closure capturing the outer curry parameter plus its
// own parameter. Both x and y must reach the consumer (ask#1 -> ask#3, ask#2 -> ask#3).
function curry(a: string): (b: string) => string {
  return (b: string) => `${a} ${b}`;
}
const x = await agent("x").ask<string>("X");
const y = await agent("y").ask<string>("Y");
const combined = curry(x)(y);
const c = await agent("c").ask<string>(`use ${combined}`);
return c;
