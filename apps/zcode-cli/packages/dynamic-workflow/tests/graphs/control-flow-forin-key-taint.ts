// for-in over a tainted object's keys: the key strings ARE derived from the
// ask result at runtime ("strings launder nothing"), so ask#1 must feed ask#2.
const data = await agent("scan").ask<Record<string, string>>("map modules to owners");
let keys = "";
for (const k in data) {
  keys += k;
}
return agent("plan").ask<string>(`plan for ${keys}`);
