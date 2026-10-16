// Curry + .call: g = make(topic) returns an arrow capturing make's param a; then
// g.call(null, extra) invokes it. At runtime BOTH topic (captured) and extra
// (positional) flow into ask#1. Probes that the captured flow survives .call
// (placeholder through the summary) while the positional one is misaligned.
//
// The snapshot also carries a SOUND extra edge `extra(ask#3) -> sink` (not a bug): on the
// first fixpoint pass make's summary is not yet computed, so `g` carries no `.fns` and
// `g.call(null, extra)` is analyzed as an unknown call — which correctly returns the union
// of its arguments (extra included). Gen-only monotonicity then keeps that edge. This is an
// inherent higher-order fixpoint-warmup over-approximation, not specific to `.call`.
const judge = agent("judge");
function make(a: string): (b: string) => Node<string> {
  return (b: string) => judge.ask<string>(`judge ${a} ${b}`);
}
const topic = await agent("t").ask<string>("topic");
const extra = await agent("e").ask<string>("extra");
const g = make(topic);
const out = await g.call(null, extra);
return out;
