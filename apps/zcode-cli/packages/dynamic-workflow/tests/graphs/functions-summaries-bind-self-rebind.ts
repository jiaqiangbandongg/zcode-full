// Self-rebinding a function value: `h = h.bind(null, "x")` appends one element to h's bind
// prefix on EVERY fixpoint pass, so the value grew in LENGTH rather than in nesting depth —
// VALUE_DEPTH_CAP never fired, mergeBound kept extending the prefix element-wise and
// reported `changed` forever (the ITERATION_CAP throw). The prefix LENGTH is capped now, and
// an over-cap element degrades into the value's occurrences (a smear, never a drop).
// Expected: the flow through the eventual call survives the cap — ask#1 -> ask#2 data
// inexact (a bound dispatch never proves its alignment); ask#2 -> sink.
function joinParts(...parts: string[]): string {
  return parts.join("");
}
let h: (...parts: string[]) => string = joinParts;
h = h.bind(null, "x");
return agent("reader").ask<string>(`${h(await agent("a").ask<string>("s"))}`);
