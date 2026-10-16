// for await...of over an array of Nodes: elements carry both asks' labels.
const planner = agent("planner");
const tasks = [planner.ask("t1"), planner.ask("t2")];
const results: string[] = [];
for await (const r of tasks) {
  results.push(r);
}
return agent("act").ask(`summarize ${results.join(",")}`);
