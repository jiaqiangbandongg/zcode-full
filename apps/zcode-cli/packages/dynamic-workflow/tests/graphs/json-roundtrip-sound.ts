// serialize/parse round-trip must preserve taint: JSON.stringify collapses the
// object's taint into the blob, JSON.parse carries it, and the field read of
// parsed.payload observes it. Sound today: ask#1 -> ask#2, ask#2 -> sink.
const a = await agent("alpha").ask<string>("start");
const blob = JSON.stringify({ payload: a, note: "x" });
const parsed = JSON.parse(blob) as { payload: string; note: string };
const b = await agent("beta").ask<string>(parsed.payload);
return b;
