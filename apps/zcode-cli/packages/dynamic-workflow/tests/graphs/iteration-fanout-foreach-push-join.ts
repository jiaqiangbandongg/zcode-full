// forEach writing un-awaited asks into an OUTER array via closure, then Promise.all
// over it: join over a fan-out's per-element work. The captured `pending` is a live
// env slot, so push lands where the join reads it.
// Expected: source -> world-read#1; world-read#1 -> fan-out#1;
//           world-read#1 -> ask#1; fan-out#1 -> ask#1; ask#1 -> join#1 (MUST);
//           join#1 -> sink; ask#1 -> sink.
const paths = await files.glob("src/*.ts");
const pending: Node<string>[] = [];
paths.forEach((p) => {
  pending.push(agent("worker").ask<string>(p));
});
const results = await Promise.all(pending);
return results;
