// Callback invocation family: a callback handed to a helper and invoked through the helper's
// PARAMETER. The checker cannot resolve `job()` to a declaration, but the call oracle knows
// the parameter holds the arrow, so the body inlines inside `withRetry`'s call region — in
// phase#1, before the checker's ask in phase#2.
phase("work");
async function withRetry(job: () => Node<string>): Promise<string> {
  return await job();
}
const a = await withRetry(() => agent("worker").ask<string>("do it"));
phase("check");
const b = await agent("checker").ask<string>(`check ${a}`);
return b;
