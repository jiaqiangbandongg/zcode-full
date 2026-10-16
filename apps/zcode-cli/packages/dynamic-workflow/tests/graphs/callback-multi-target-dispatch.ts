// Callback invocation family: an indirect dispatch that may reach EITHER of two script
// functions. The oracle records both as callee applications, so the call inlines as one
// exhaustive `choice` with a `branch > call` arm per target: exactly one runs, each `maybe`.
const seed = await agent("seed").ask<string>("seed");
const fast = (s: string) => agent("fast").ask<string>(`fast ${s}`);
const slow = (s: string) => agent("slow").ask<string>(`slow ${s}`);
const pick = seed.length > 3 ? fast : slow;
const out = await pick(seed);
return out;
