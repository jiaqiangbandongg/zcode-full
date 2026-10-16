// The regression guard for keeping the SYNTACTIC controller scan in phase 2's control
// union. `flag` is 1 or 2: a ternary's condition deliberately does not join the data
// contract (the same convention as a computed index key), so the taint oracle sees no
// label on the guard and has nothing to say about it. The syntactic map does — it recorded
// the decider's ask against `flag` when the declaration bound it. Replacing the scan with
// the oracle instead of unioning the two would silently drop this `control` edge.
const flag = (await agent("decider").ask<boolean>("q")) ? 1 : 2;
if (flag) {
  return await agent("actor2").ask<string>("go");
}
return "skipped";
