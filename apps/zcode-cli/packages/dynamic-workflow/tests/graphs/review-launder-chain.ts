// Realistic writer -> reviewer -> reviser workflow; the feedback is reformatted via a
// String.raw tagged template mid-pipeline. Tagged templates are treated as tag calls,
// so taint survives: the untainted-template link (writer -> reviewer) and the
// tagged-template link (reviewer -> reviser) both hold.
// Expected: ask#1 -> ask#2, ask#2 -> ask#3, ask#3 -> sink.
const draft = await agent("writer").ask<string>("Write a draft");
const review = await agent("reviewer").ask<string>(`Review this:\n${draft}`);
const prompt = String.raw`Revise based on feedback: ${review}`;
const final = await agent("reviser").ask<string>(prompt);
return final;
