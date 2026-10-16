// report 是站点但**在两张图里都不是节点**：它发的是进度而不是次序，没有什么能等它，
// 所以没有什么可以让一条边去表示（docs/analysis.md 的「Sites」：report 有站点
// 却不是节点、不是 step）。
//
// 这份 fixture 的快照就是那条排除规则的可执行形态：下面每个 report 调用都不该在
// .txt / .actor.txt / .causality.txt 里留下任何节点或边，它的实参也不该被当作 sink
// （`plan` 流进 report 不产生 data 边，只有流进 reviewer.ask 的那条才算）。
interface Plan {
  steps: string[];
}

const planner = agent("planner");
const reviewer = agent("reviewer");

const plan = await planner.ask<Plan>("draft a plan");
report({ phase: "planned", steps: plan.steps.length });

const reviews: string[] = [];
for (const step of plan.steps) {
  const verdict = await reviewer.ask<string>(step);
  report({ phase: "reviewed", step, verdict });
  reviews.push(verdict);
}

report({ phase: "done", total: reviews.length });
return reviews;
