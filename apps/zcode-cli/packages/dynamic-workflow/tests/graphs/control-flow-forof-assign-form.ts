// for...of with an ASSIGNMENT-form initializer (pre-declared variable, no
// declaration list): the loop variable receives each element at runtime.
const notes = await agent("scan").ask<string[]>("list issues");
let cur = "";
for (cur of notes) {
  log(cur);
}
return agent("fix").ask<string>(`fix ${cur}`);
