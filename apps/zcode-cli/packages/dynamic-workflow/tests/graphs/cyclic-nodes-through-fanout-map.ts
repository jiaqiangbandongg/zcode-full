// Cyclic linked-list nodes iterated by .map; the callback writes a tainted field and
// asks. Exercises cycle-safety THROUGH a promoted fan-out (distinct from circular-ref,
// which never iterates the cycle). Must terminate and emit the fan-out + all edges.
// Note: the callback mutates the iterated element (`n.f = secret`), and the element-
// mutation write-back merges that field into the `nodes` collection place. Since the
// fan-out INPUT is collapse(nodes), secret reaches it — so the fan-out gains a real
// `ask#1 -> fan-out#1` data edge, which DISPLACES the synthetic `source -> fan-out#1`
// graph-completion edge (source→X is auto-added only when X has no incoming data edge).
// source still reaches the fan-out transitively (source -> ask#1 -> fan-out#1); no
// connectivity or soundness is lost. Restricting write-back away from .map would reopen a
// real soundness hole (a map that mutates then re-reads the source array).
type N = { next?: N; f?: string };
const n1: N = {};
const n2: N = {};
n1.next = n2;
n2.next = n1;
const nodes: N[] = [n1, n2];
const secret = await agent("writer").ask<string>("secret");
const outs = nodes.map((n) => {
  n.f = secret;
  return agent("judge").ask<string>(`check ${n.f}`);
});
return (await Promise.all(outs)).join();
