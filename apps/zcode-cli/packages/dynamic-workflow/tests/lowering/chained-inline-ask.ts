interface Plan {
  steps: string[];
}

const plan = await agent("planner", { system: "You plan tasks" }).ask<Plan>("Make a plan");
return plan.steps.length;
