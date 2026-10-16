// The comma (sequence) operator yields its RIGHT operand at runtime, so
// `alias` and `box` are ONE object; a write through alias is visible via box.
const box = { note: "" };
let picks = 0;
const alias = (picks++, box);
alias.note = await agent("a").ask<string>("secret");
log(`picks ${picks}`);
return agent("b").ask<string>(`use ${box.note}`);
