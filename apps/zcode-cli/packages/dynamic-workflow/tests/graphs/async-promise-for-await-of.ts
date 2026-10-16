// for await...of over an array of Nodes: the loop variable is the awaited element.
// The body reaches no facade site, so no fan-out node is promoted, but element
// taint must still flow into `parts` and on to the merger.
// Expected: ask#1 -> ask#3; ask#2 -> ask#3; ask#3 -> sink; NO fan-out node.
const nodes = [agent("alpha").ask<string>("a"), agent("beta").ask<string>("b")];
const parts: string[] = [];
for await (const t of nodes) {
  parts.push(t);
}
return agent("merger").ask<string>(`merge ${parts.join(", ")}`);
