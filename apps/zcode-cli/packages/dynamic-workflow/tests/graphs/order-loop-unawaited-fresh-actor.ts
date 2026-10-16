// The same un-awaited loop, but the actor is created INSIDE the body: one fresh actor
// per round, so the instances genuinely coexist. Cue is a stack (repeat=stack), no
// self-arrow — the split is on concurrency, not cardinality.
const topics = await files.glob("*.md");
for (const topic of topics) {
  agent("noter").ask<string>(`note ${topic}`);
}
return topics;
