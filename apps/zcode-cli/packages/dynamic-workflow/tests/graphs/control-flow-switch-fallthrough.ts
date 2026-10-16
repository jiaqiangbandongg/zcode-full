// switch fallthrough + default: taint reaches msg through every clause shape.
const verdict = await agent("judge").ask<string>("verdict");
let msg = "";
switch (verdict.length) {
  case 0:
    msg = verdict;
  // fallthrough
  case 1:
    msg += " (short)";
    break;
  default:
    msg = `long: ${verdict}`;
}
return agent("act").ask<string>(`handle ${msg}`);
