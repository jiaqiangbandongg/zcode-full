// A promise passed INTO a helper and awaited there. The helper is inlined at its call
// site, so the barrier lands at the right point in time; the awaited expression is a
// parameter, which issues nothing, so it widens exactly like a stored promise. The
// trailing ask is what makes the widened barrier visible as a `maybe` edge.
async function settle(p: Node<string>): Promise<string> {
  return await p;
}
const worker = agent("worker");
const pending = worker.ask<string>("work");
const other = await agent("other").ask<string>("other");
const done = await settle(pending);
const summary = await agent("summarizer").ask<string>("wrap up");
return `${done} ${other} ${summary}`;
