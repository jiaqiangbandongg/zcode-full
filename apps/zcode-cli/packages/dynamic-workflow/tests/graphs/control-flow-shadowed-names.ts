// Two distinct symbols named x: the inner (tainted) one must flow out via out,
// while the outer x is clean — checker symbols must not conflate.
const x = "clean";
let out = "";
{
  const x = await agent("a").ask("secret");
  out = x;
}
return agent("b").ask(`inner ${out} outer ${x}`);
