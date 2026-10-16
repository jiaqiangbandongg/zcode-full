// JSON deep-clone round-trip. At runtime clone.f === secret, and the reader ask
// reads it. Sound today via collapse: JSON.stringify collapses obj's taint into the
// string, JSON.parse (an unknown call) carries it through, and the field read of
// clone.f observes it. Expected: source -> ask#1, ask#1 -> ask#2, ask#2 -> sink.
const secret = await agent("writer").ask<string>("secret");
const obj = { f: secret };
const clone = JSON.parse(JSON.stringify(obj)) as { f: string };
const out = await agent("reader").ask<string>(`use ${clone.f}`);
return out;
