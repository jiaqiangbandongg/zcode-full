// A recursive helper: the SCC is a `loop` region in the trace, and the re-entrant call is a
// `jump recur` back to it — on the CFG a back edge from the step before the recursive call
// to the loop's entry.
async function refine(draft: string, depth: number): Promise<string> {
  const review = await agent("critic").ask<string>(`review round ${depth}: ${draft}`);
  if (depth >= 3 || review.startsWith("ok")) return review;
  return refine(review, depth + 1);
}

const seed = await agent("writer").ask<string>("first draft");
return refine(seed, 0);
