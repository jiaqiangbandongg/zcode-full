// throw/catch dataflow: a facade site inside a thrown expression must be evaluated,
// and the catch binding must read the thrown value (ask#2 result) that is returned.
const a = await agent("alpha").ask<string>("one");
try {
  throw await agent("beta").ask<string>(`Rethink: ${a}`);
} catch (e) {
  return e as string;
}
