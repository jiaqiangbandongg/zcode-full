// do-while: loop-carried draft feeds the SAME ask's instructions next round.
const planner = agent("planner");
let draft = "";
let rounds = 0;
do {
  draft = await planner.ask<string>(`draft, previous: ${draft}`);
  rounds += 1;
} while (rounds < 2);
return draft;
