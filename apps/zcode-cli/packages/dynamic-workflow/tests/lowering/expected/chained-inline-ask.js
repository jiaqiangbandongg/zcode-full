const plan = await __host.ask("ask#1", __host.createActor("actor#1", "planner", { system: "You plan tasks" }), "Make a plan");
return plan.steps.length;
