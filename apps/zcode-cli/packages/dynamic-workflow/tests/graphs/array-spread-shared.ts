// Sole-element array spread `[...arr1]` shallow-copies: `arr2[0] === arr1[0]` (shared
// reference), so writing secret through arr2[0] is visible through arr1[0] at runtime. A
// spread mixed with other elements is a documented residual (folds by value); this pins
// the sole-spread sharing the spec models soundly.
// Expected: source -> ask#1, ask#1 -> ask#2 (secret through the shared element), ask#2 -> sink.
const arr1: { g: string }[] = [{ g: "" }];
const arr2 = [...arr1];
const secret = await agent("writer").ask<string>("secret");
arr2[0]!.g = secret;
const out = await agent("reader").ask<string>(`use ${arr1[0]!.g}`);
return out;
