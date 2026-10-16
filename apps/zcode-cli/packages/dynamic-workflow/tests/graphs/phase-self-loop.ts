// A refine-until-approved loop living entirely inside one phase. At the step level the
// loop closes as a two-step cycle (plan → review forward, review → plan carry); quotiented
// by a single phase the forward hop dissolves (intra-phase order is not drawn) and the
// carry survives as the phase's SELF edge — the "the whole loop is in here" reading.

interface Review {
  approved: boolean;
  /** What to change on the next round. */
  feedback: string;
}

phase("refine");
const planner = agent("planner");
const reviewer = agent("reviewer");

let feedback = "none";
let plan = "";
for (let round = 0; round < 3; round++) {
  plan = await planner.ask<string>(`Plan the fixes. Feedback: ${feedback}`);
  const review = await reviewer.ask<Review>(`Critique:\n${plan}`);
  if (review.approved) return plan;
  feedback = review.feedback;
}
return plan;
