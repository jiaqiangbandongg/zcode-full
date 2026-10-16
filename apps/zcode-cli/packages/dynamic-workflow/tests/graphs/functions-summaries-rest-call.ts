// .call on a function whose ONLY formal is a rest parameter: the rest placeholder
// gathers every actual at index >= 0, which accidentally includes the shifted
// secret at index 1 — probing that rest params neutralize the .call misalignment.
const judge = agent("judge");
const secret = await agent("s").ask<string>("make secret");
function f(...xs: string[]): Node<string> {
  return judge.ask<string>(`judge ${xs.join(" ")}`);
}
const out = await f.call(null, secret);
return out;
